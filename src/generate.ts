import * as path from "path"
import { OpenAPIV3 } from "openapi-types"
import SwaggerParser from "swagger-parser"
import { format, resolveConfig } from "prettier"
import { get, flatMap, intersection } from "lodash"

import { PathOperation, Operation, OPERATIONS } from "./types"

import {
  formatPathOp,
  formatLib,
  formatTypeDeclaration,
  formatTypeField,
  isTypeNamed
} from "./format"

interface TypeImpl {
  impl: string
  description?: string
}

export interface ParsedOpenApi {
  pathOps: PathOperation[]
  namedTypes: { [name: string]: TypeImpl }
}
class Generator implements ParsedOpenApi {
  public pathOps: PathOperation[] = []
  public namedTypes: { [name: string]: TypeImpl } = {}

  private doc: OpenAPIV3.Document

  constructor(doc: OpenAPIV3.Document, readonly withDoc: boolean = true) {
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
      operationId: operationObj.operationId,
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
      return { description, required, mediaType: fallbackEntry[0], type: "any" }
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
        this.namedTypes[typeName] = { impl: typeName }
      }

      const schema = this.followReference(obj)
      const typeImpl = this.getTypeFromSchemaObj(schema)

      this.namedTypes[typeName] = {
        impl: typeImpl,
        description: schema.description
      }

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
    const requiredProps = this.getRequiredProperties(obj)
    const fields = Object.entries(obj.properties).map(([name, value]) => {
      const readOnly = (value as any).readOnly
      const description = (value as any).description
      const required = requiredProps.includes(name)

      let retVal = ""
      if (this.withDoc && description) {
        retVal = `/** ${description} */\n  `
      }
      return `${retVal}${formatTypeField(readOnly, name, required, this.getType(value))}`
    })

    return `{\n  ${fields.join("\n  ")}\n}`
  }

  private getRequiredProperties(obj: OpenAPIV3.NonArraySchemaObject): string[] {
    if (obj.required) {
      return obj.required
    }
    let required: string[] | undefined
    if (obj.oneOf && obj.oneOf.length) {
      // DBRP type defines required properties using oneOf combinations
      // required are those that are present in all combinations
      obj.oneOf.forEach((schema: any) => {
        if (schema.required && schema.required.length) {
          if (required === undefined) {
            required = schema.required
          } else {
            required = intersection(required, schema.required)
          }
        }
      })
    }
    return required || []
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
  withDoc: boolean
  patchScript?: string
  onParsed?: (parsed: ParsedOpenApi) => void
}

const componentTypes = [
  "schemas",
  "responses",
  "examples",
  "requestBodies",
  "headers",
  "securitySchemes",
  "links",
  "callbacks"
]

export async function generate(
  docPath: string | string[],
  generateOptions: Partial<GenerateOptions> = {}
): Promise<string> {
  let doc: OpenAPIV3.Document
  if (!Array.isArray(docPath)) {
    docPath = [docPath]
  }
  for (const path of docPath) {
    const newDoc = (await SwaggerParser.bundle(path)) as OpenAPIV3.Document
    if (!doc) {
      doc = newDoc
      if (!doc.components) {
        doc.components = {}
      }
    } else {
      // merge paths, do not override
      for (const [path, pathItemObj] of Object.entries(newDoc.paths)) {
        if (!doc.paths[path]) {
          doc.paths[path] = pathItemObj
        }
      }
      // merge types
      if (newDoc.components) {
        for (const componentType of componentTypes) {
          if (newDoc.components[componentType]) {
            for (const [key, val] of Object.entries(
              newDoc.components[componentType]
            )) {
              if (!doc.components[componentType]) {
                doc.components[componentType] = {}
              }
              if (!doc.components[componentType][key]) {
                doc.components[componentType][key] = val
              }
            }
          }
        }
      }
    }
    if (generateOptions.patchScript) {
      const patchScript = require(generateOptions.patchScript)
      doc = await patchScript.patch(doc, SwaggerParser)
    }
  }
  const options: GenerateOptions = {
    types: true,
    request: true,
    operations: true,
    prettier: true,
    withDoc: true,
    patchScript: null,
    ...generateOptions
  }
  const generator = new Generator(doc, options.withDoc)
  if (options.onParsed) {
    options.onParsed(generator)
  }

  let output = ""

  if (options.types) {
    output += Object.entries(generator.namedTypes)
      .map(([name, typeImpl]) =>
        formatTypeDeclaration(
          name,
          typeImpl.impl,
          options.withDoc ? typeImpl.description : ""
        )
      )
      .join("\n\n")
    output += "\n\n"
  }
  if (options.request) {
    output += formatLib()
    output += "\n\n"
  }
  if (options.operations) {
    output += generator.pathOps.map(op => formatPathOp(op)).join("\n\n")
  }

  if (output) {
    output =
      "// This file is generated by [oats][0] and should not be edited by hand.\n//\n// [0]: https://github.com/influxdata/oats\n\n" +
      output
  }

  if (output && options.prettier) {
    // Assumes that the location of this module is in:
    //
    //     $PROJECT/node_modules/@influxdata/oats/dist
    //
    // We want to use `$PROJECT` as the location of the prettier config.
    const prettierLocation = path.resolve(__dirname, "..", "..", "..", "..")

    const prettierConfig = await resolveConfig(prettierLocation)

    output = format(output, {
      ...prettierConfig,
      parser: "typescript"
    })
  }

  return output
}
