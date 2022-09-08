import * as path from "path"
import { OpenAPIV3 } from "openapi-types"
import { bundle } from "swagger-parser"
import { format, resolveConfig } from "prettier"
import { get, flatMap } from "lodash"

import { PathOperation, Operation, OPERATIONS } from "./types"

import {
  formatPathOp,
  formatLib,
  formatTypeDeclaration,
  formatTypeField,
  isTypeNamed
} from "./format"

class Generator {
  public pathOps: PathOperation[] = []
  public namedTypes: { [name: string]: string } = {}

  private doc: OpenAPIV3.Document

  constructor(doc: OpenAPIV3.Document) {
    this.doc = doc

    for (const [path, pathItemObj] of Object.entries(doc.paths)) {
      for (const op of OPERATIONS) {
        if (pathItemObj[op]) {
          this.registerPathOperation(path, op, pathItemObj[op])
        }
      }
    }
  }

  private registerPathOperation(
    path: string,
    operation: Operation,
    operationObj: OpenAPIV3.OperationObject
  ) {
    const parameters: OpenAPIV3.ParameterObject[] = (
      operationObj.parameters || []
    ).map(p => this.followReference(p))

    const pathOp: PathOperation = {
      server: this.doc.servers[0].url,
      path,
      operation,
      basicAuth: this.requiresBasicAuth(operationObj),
      summary: operationObj.summary,
      positionalParams: this.collectParameters(parameters, "path"),
      headerParams: this.collectParameters(parameters, "header"),
      queryParams: this.collectParameters(parameters, "query"), // TODO: Support "string[]" parameters
      bodyParam: this.collectBodyParam(operationObj),
      responses: this.collectResponses(operationObj.responses)
    }

    this.pathOps.push(pathOp)
  }

  private requiresBasicAuth(operationObj: OpenAPIV3.OperationObject): boolean {
    if (!operationObj.security) {
      return false
    }

    const securitySchemeNames = flatMap(operationObj.security, d =>
      Object.keys(d)
    )
    const securitySchemes = get(this.doc, "components.securitySchemes", {})

    return securitySchemeNames.some(name => {
      if (!securitySchemes[name]) {
        return false
      }

      const scheme = this.followReference(securitySchemes[name])

      return scheme.type === "http" && scheme.scheme === "basic"
    })
  }

  private collectParameters(
    allParameters: OpenAPIV3.ParameterObject[],
    parameterLocation: "query" | "path" | "header"
  ) {
    return allParameters
      .filter(p => p.in === parameterLocation)
      .map(p => ({
        name: p.name,
        description: p.description,
        required: p.required,
        type: this.expectSimpleType(p)
      }))
  }

  private collectBodyParam(
    operationObj: OpenAPIV3.OperationObject
  ): PathOperation["bodyParam"] {
    if (!operationObj.requestBody) {
      return null
    }

    const requestBody: OpenAPIV3.RequestBodyObject = this.followReference(
      operationObj.requestBody
    )

    const mediaTypeEntries = Object.entries(requestBody.content)
    const { description, required = false } = requestBody

    const jsonEntry = mediaTypeEntries.find(([mediaType]) =>
      mediaType.includes("application/json")
    )

    if (jsonEntry) {
      return {
        description,
        required,
        mediaType: jsonEntry[0],
        type: this.getType(jsonEntry[1].schema)
      }
    }

    const textEntry = mediaTypeEntries.find(([mediaType]) =>
      mediaType.includes("text")
    )

    if (textEntry) {
      return { description, required, mediaType: textEntry[0], type: "string" }
    }

    const fallbackEntry = mediaTypeEntries[0]

    if (fallbackEntry) {
      return { description, required, mediaType: textEntry[0], type: "any" }
    }

    return null
  }

  private collectResponses(
    responses?: OpenAPIV3.ResponsesObject
  ): PathOperation["responses"] {
    if (!responses) {
      return null
    }

    return Object.entries(responses).map(([responseCode, refOrResponse]) => {
      const responseObj: OpenAPIV3.ResponseObject = this.followReference(
        refOrResponse
      )

      let mediaTypes = []

      if (responseObj.content) {
        mediaTypes = Object.entries(responseObj.content).map(
          ([mediaType, mediaTypeObj]) => ({
            mediaType,
            type: this.getType(mediaTypeObj.schema)
          })
        )
      }

      return {
        code: responseCode,
        description: responseObj.description,
        mediaTypes
      }
    }, [])
  }

  private followReference(obj) {
    if ("$ref" in obj) {
      return get(this.doc, obj.$ref.split("/").slice(1))
    }

    return obj
  }

  private expectSimpleType(obj): "string" | "number" | "any" {
    switch (get(obj, "schema.type", null)) {
      case "string":
        return "string"
      case "integer":
      case "number":
        return "number"
      default:
        return "any"
    }
  }

  private getRefName(refString: string): string {
    const refParts = refString.split("/")
    const name = refParts[refParts.length - 1]

    return name
  }

  private getType(
    obj: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject
  ): string {
    if ("$ref" in obj) {
      const typeName = this.getRefName(obj.$ref)
      const existingImpl = this.namedTypes[typeName]

      // Guard against self-referential types
      if (existingImpl) {
        return typeName
      } else {
        this.namedTypes[typeName] = typeName
      }

      const schema = this.followReference(obj)
      const typeImpl = this.getTypeFromSchemaObj(schema)

      this.namedTypes[typeName] = typeImpl

      return typeName
    }

    return this.getTypeFromSchemaObj(obj)
  }

  private getTypeFromSchemaObj(obj: OpenAPIV3.SchemaObject): string {
    switch (obj.type) {
      case "number":
      case "integer":
        return "number"
      case "boolean":
        return "boolean"
      case "string":
        return obj.enum ? obj.enum.map(v => `"${v}"`).join(" | ") : "string"
      case "null":
        return "null"
      case "array":
        return this.getTypeFromArraySchemaObj(obj)
      case "object":
      default:
        return this.getTypeFromObjectSchemaObj(obj)
    }
  }

  private getTypeFromArraySchemaObj(obj: OpenAPIV3.ArraySchemaObject): string {
    const type = this.getType(obj.items)

    return isTypeNamed(type) ? `${type}[]` : `Array<${type}>`
  }

  private getTypeFromObjectSchemaObj(
    obj: OpenAPIV3.NonArraySchemaObject
  ): string {
    if (obj.allOf) {
      return this.getTypeFromAllOf(obj)
    }

    if (obj.oneOf) {
      return this.getTypeFromOneOf(obj)
    }

    if (obj.anyOf) {
      return this.getTypeFromOneOf(obj)
    }

    if (obj.properties) {
      return this.getTypeFromPropertiesSchemaObj(obj)
    }

    return "any"
  }

  private getTypeFromPropertiesSchemaObj(
    obj: OpenAPIV3.NonArraySchemaObject
  ): string {
    const fields = Object.entries(obj.properties).map(([name, value]) => {
      const readOnly = (value as any).readOnly
      const required = (obj.required || []).includes(name)

      return formatTypeField(readOnly, name, required, this.getType(value))
    })

    return `{\n  ${fields.join("\n  ")}\n}`
  }

  private getTypeFromAllOf(obj: OpenAPIV3.SchemaObject): string {
    return obj.allOf.map(childObj => this.getType(childObj)).join(" & ")
  }

  private getTypeFromOneOf(obj: OpenAPIV3.SchemaObject): string {
    return obj.oneOf
      .map(childObj => {
        const type = this.getType(childObj)

        if (obj.discriminator) {
          const mappingKey = Object.keys(obj.discriminator).find(
            key => obj.discriminator.mapping[key] === (childObj as any).$ref
          )

          const propertyValue = mappingKey ? `"${mappingKey}"` : "string"

          return `(${type} & {${obj.discriminator.propertyName}: ${propertyValue}})`
        }

        return type
      })
      .join(" | ")
  }
}

export interface GenerateOptions {
  types: boolean
  request: boolean
  operations: boolean
  prettier: boolean
}

export async function generate(
  docOrPathToDoc: string | OpenAPIV3.Document,
  generateOptions: Partial<GenerateOptions>
): Promise<string> {
  const doc = (await bundle(docOrPathToDoc)) as OpenAPIV3.Document
  const generator = new Generator(doc)
  const options: GenerateOptions = {
    types: true,
    request: true,
    operations: true,
    prettier: true,
    ... generateOptions
  }

  let messyOutput =
    "// This file is generated by [oats][0] and should not be edited by hand.\n//\n// [0]: https://github.com/influxdata/oats\n\n"

  if (options.types){
    messyOutput += Object.entries(generator.namedTypes)
      .map(([name, impl]) => formatTypeDeclaration(name, impl))
      .join("\n\n")
    messyOutput += "\n\n"
  }
  if (options.request){
    messyOutput += formatLib()
    messyOutput += "\n\n"
  }
  if (options.operations){
    messyOutput += generator.pathOps.map(op => formatPathOp(op)).join("\n\n")
  }

  if (options.prettier){
      // Assumes that the location of this module is in:
    //
    //     $PROJECT/node_modules/@influxdata/oats/dist
    //
    // We want to use `$PROJECT` as the location of the prettier config.
    const prettierLocation = path.resolve(__dirname, "..", "..", "..", "..")

    const prettierConfig = await resolveConfig(prettierLocation)

    messyOutput = format(messyOutput, {
      ...prettierConfig,
      parser: "typescript"
    })
  }

  return messyOutput
}
