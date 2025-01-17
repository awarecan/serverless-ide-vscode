import { JSONSchema } from "./jsonSchema"
import { CompletionItem } from "vscode-json-languageservice"
import * as PromisePool from "es6-promise-pool"
import noop = require("lodash/noop")
import { CfnLintFailedToExecuteError } from "./services/validation/errors"
import {
	IConnection,
	TextDocuments,
	TextDocumentPositionParams,
	ResponseError,
	ReferenceParams,
	Location,
	DocumentLinkParams
} from "vscode-languageserver"
import {
	CompletionList,
	Position,
	TextDocument,
	DocumentSymbol,
	Hover,
	Definition,
	DocumentLink
} from "vscode-languageserver-types"
import { LanguageSettings } from "./model/settings"
import { parse } from "./parser"
import { YAMLCompletion } from "./services/completion"
import { findDocumentSymbols } from "./services/documentSymbols"
import { YAMLHover } from "./services/hover"
import { JSONSchemaService } from "./services/jsonSchema"
import { YAMLValidation } from "./services/validation"
import {
	DocumentService,
	WorkplaceFiles,
	LifecycleCallbacks
} from "./services/document"
import { sendAnalytics, sendException } from "./services/analytics"
import { completionHelper } from "./utils/completion-helper"
import { getDefinition } from "./services/definition"
import { getReferences } from "./services/reference"
import { promiseRejectionHandler } from "./utils/errorHandler"
import { findDocumentLinks } from "./services/links"

export interface LanguageService {
	configure(settings: LanguageSettings): void
	doComplete(
		document: TextDocument,
		position: Position
	): Promise<CompletionList>
	doValidation(uri: string): Promise<void>
	doHover(
		document: TextDocument,
		position: Position
	): Promise<Hover | ResponseError<void>>
	findDocumentSymbols(document: TextDocument): Promise<DocumentSymbol[]>
	findDefinitions(
		documentPosition: TextDocumentPositionParams
	): Promise<Definition | ResponseError<void>>
	findReferences(
		params: ReferenceParams
	): Promise<Location[] | ResponseError<void>>
	findLinks(params: DocumentLinkParams): Promise<DocumentLink[]>
	doResolve(completionItem: CompletionItem): Promise<CompletionItem>
	clearDocument(uri: string): void
}

const VALIDATION_DELAY_MS = 200

export class LanguageServiceImpl implements LanguageService {
	private connection: IConnection
	private schemaService: JSONSchemaService
	private documentService: DocumentService
	private completer: YAMLCompletion
	private hover: YAMLHover
	private validation: YAMLValidation
	private pendingValidationRequests: { [uri: string]: NodeJS.Timer } = {}

	constructor(
		settings: LanguageSettings,
		connection: IConnection,
		documents: TextDocuments
	) {
		this.connection = connection

		const externalImportsCallbacks = {
			onRegisterExternalImport: (uri: string, parentUri: string) => {
				this.documentService.registerChildParentRelation(uri, parentUri)
			},
			onValidateExternalImport: promiseRejectionHandler(
				async (
					uri: string,
					parentUri: string,
					schema: JSONSchema,
					property?: string
				): Promise<void> => {
					const document = await this.documentService.getTextDocument(
						uri
					)

					this.schemaService.registerPartialSchema(
						uri,
						schema,
						property
					)

					const yamlDocument = await this.documentService.getYamlDocument(
						uri
					)

					await this.validation.doExternalImportValidation(
						document,
						yamlDocument
					)
				}
			)
		}

		const triggerValidationForWorkspaceFiles = (files: WorkplaceFiles) => {
			const uris = Object.keys(files)
			let currentIndex = 0

			const nextPromise = () => {
				if (currentIndex >= uris.length) {
					return null
				}

				const promise = this.doValidation(uris[currentIndex]).catch(
					sendException
				)

				currentIndex += 1

				return promise
			}

			const pool = new (PromisePool as any)(nextPromise, 3)

			pool.start()
		}

		const lifecycleCallbacks: LifecycleCallbacks = {
			onWorkplaceFilesInitialized: triggerValidationForWorkspaceFiles,
			onWorkplaceFilesChanged: triggerValidationForWorkspaceFiles,
			onFileCreated: (uri: string) => {
				this.doValidation(uri)
			},
			onFileDeleted: (uri: string) => {
				this.clearDocument(uri)
			},
			onFileChanged: promiseRejectionHandler(async (uri: string) => {
				const children = this.documentService.getChildrenUris(uri)

				// if parent document is changed
				if (children && children.length) {
					children.forEach(childUri => {
						this.schemaService.clearPartialSchema(childUri)
					})
					this.documentService.clearRelations(uri)
				}

				await this.doValidation(uri)
			}),
			onFileOpened: promiseRejectionHandler(async (uri: string) => {
				await this.doValidation(uri)
			}),
			onFileClosed: noop
		}

		this.schemaService = new JSONSchemaService()
		this.documentService = new DocumentService(
			connection,
			documents,
			externalImportsCallbacks,
			lifecycleCallbacks
		)

		this.completer = new YAMLCompletion(this.schemaService)
		this.hover = new YAMLHover(this.schemaService)
		this.validation = new YAMLValidation(
			this.schemaService,
			settings.workspaceRoot,
			connection
		)
	}

	configure(newSettings: LanguageSettings) {
		this.validation.configure(newSettings)
		this.hover.configure(newSettings)
		this.completer.configure(newSettings)
	}

	doComplete = async (document: TextDocument, position: Position) => {
		const result: CompletionList = {
			items: [],
			isIncomplete: false
		}

		if (!document) {
			return result
		}

		try {
			const completionFix = completionHelper(document, position)
			const originalYamlDocument = await this.documentService.getYamlDocument(
				document.uri
			)
			const yamlDocument = parse(
				completionFix.newDocument,
				undefined,
				originalYamlDocument.parentParams
			)
			return this.completer.doComplete(document, position, yamlDocument)
		} catch (err) {
			sendException(err)
			return result
		}
	}

	doResolve(completionItem: CompletionItem): Promise<CompletionItem> {
		sendAnalytics({
			action: "resolveCompletion",
			attributes: {
				label: completionItem.label,
				documentType:
					completionItem.data && completionItem.data.documentType
			}
		})

		return this.completer.doResolve(completionItem)
	}

	doValidation = promiseRejectionHandler(
		(uri: string): Promise<void> => {
			this.cleanPendingValidation(uri)

			return new Promise((resolve, reject) => {
				this.pendingValidationRequests[uri] = setTimeout(() => {
					delete this.pendingValidationRequests[uri]
					this.validate(uri)
						.then(resolve)
						.catch(reject)
				}, VALIDATION_DELAY_MS)
			})
		}
	)

	async findDocumentSymbols(
		document: TextDocument
	): Promise<DocumentSymbol[]> {
		try {
			const yamlDocument = await this.documentService.getYamlDocument(
				document.uri
			)
			return findDocumentSymbols(document, yamlDocument)
		} catch (err) {
			return []
		}
	}

	async findDefinitions(
		documentPosition: TextDocumentPositionParams
	): Promise<Definition | ResponseError<void>> {
		try {
			const document = await this.documentService.getTextDocument(
				documentPosition.textDocument.uri
			)
			const yamlDocument = await this.documentService.getYamlDocument(
				documentPosition.textDocument.uri
			)

			return getDefinition(documentPosition, document, yamlDocument)
		} catch (err) {
			sendException(err)
			return new ResponseError(1, err.message)
		}
	}

	async findReferences(
		referenceParams: ReferenceParams
	): Promise<Location[] | ResponseError<void>> {
		const document = await this.documentService.getTextDocument(
			referenceParams.textDocument.uri
		)

		try {
			const yamlDocument = await this.documentService.getYamlDocument(
				document.uri
			)

			return getReferences(referenceParams, document, yamlDocument)
		} catch (err) {
			sendException(err)
			return new ResponseError(1, err.message)
		}
	}

	async findLinks(linkParams: DocumentLinkParams): Promise<DocumentLink[]> {
		try {
			const document = await this.documentService.getTextDocument(
				linkParams.textDocument.uri
			)
			const yamlDocument = await this.documentService.getYamlDocument(
				document.uri
			)

			return findDocumentLinks(document, yamlDocument)
		} catch (err) {
			sendException(err)
			return []
		}
	}

	clearDocument(uri: string) {
		const children = this.documentService.getChildrenUris(uri)

		this.cleanPendingValidation(uri)
		this.documentService.clear(uri)

		// clear diagnostics
		this.connection.sendDiagnostics({
			uri,
			diagnostics: []
		})

		if (children && children.length > 0) {
			children.forEach(childUri =>
				this.schemaService.clearPartialSchema(childUri)
			)
		}
	}

	async doHover(
		document: TextDocument,
		position: Position
	): Promise<Hover | ResponseError<void>> {
		try {
			const yamlDocument = await this.documentService.getYamlDocument(
				document.uri
			)

			return this.hover.doHover(document, position, yamlDocument)
		} catch (err) {
			sendException(err)
			return new ResponseError(1, err.message)
		}
	}

	private async validate(uri: string) {
		const document = await this.documentService.getTextDocument(uri)

		if (!document) {
			return
		}

		const text = document.getText()

		if (text.length === 0) {
			this.connection.sendDiagnostics({
				uri: document.uri,
				diagnostics: []
			})
			return
		}

		try {
			const yamlDocument = await this.documentService.getYamlDocument(
				document.uri
			)
			sendAnalytics({
				action: "validateDocument",
				attributes: {
					documentType: yamlDocument.documentType
				}
			})

			await this.validation.doValidation(document, yamlDocument)
		} catch (err) {
			if (err instanceof CfnLintFailedToExecuteError) {
				this.connection.sendNotification(
					"custom/cfn-lint-installation-error"
				)
			}
		}
	}

	private cleanPendingValidation = (uri: string): void => {
		const request = this.pendingValidationRequests[uri]
		if (request) {
			clearTimeout(request)
			delete this.pendingValidationRequests[uri]
		}
	}
}
