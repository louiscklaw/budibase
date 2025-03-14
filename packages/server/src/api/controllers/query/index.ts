import { generateQueryID } from "../../../db/utils"
import { Thread, ThreadType } from "../../../threads"
import { save as saveDatasource } from "../datasource"
import { RestImporter } from "./import"
import { invalidateDynamicVariables } from "../../../threads/utils"
import env from "../../../environment"
import { events, context, utils, constants } from "@budibase/backend-core"
import sdk from "../../../sdk"
import { QueryEvent } from "../../../threads/definitions"
import {
  ConfigType,
  Query,
  UserCtx,
  SessionCookie,
  JsonFieldSubType,
  QueryResponse,
  QueryPreview,
  QuerySchema,
  FieldType,
  ExecuteQueryRequest,
  ExecuteQueryResponse,
  Row,
  QueryParameter,
  PreviewQueryRequest,
  PreviewQueryResponse,
} from "@budibase/types"
import { ValidQueryNameRegex, utils as JsonUtils } from "@budibase/shared-core"

const Runner = new Thread(ThreadType.QUERY, {
  timeoutMs: env.QUERY_THREAD_TIMEOUT,
})

export async function fetch(ctx: UserCtx) {
  ctx.body = await sdk.queries.fetch()
}

const _import = async (ctx: UserCtx) => {
  const body = ctx.request.body
  const data = body.data

  const importer = new RestImporter(data)
  await importer.init()

  let datasourceId
  if (!body.datasourceId) {
    // construct new datasource
    const info: any = await importer.getInfo()
    let datasource = {
      type: "datasource",
      source: "REST",
      config: {
        url: info.url,
        defaultHeaders: [],
        rejectUnauthorized: true,
      },
      name: info.name,
    }
    // save the datasource
    const datasourceCtx = { ...ctx }
    datasourceCtx.request.body.datasource = datasource
    await saveDatasource(datasourceCtx)
    datasourceId = datasourceCtx.body.datasource._id
  } else {
    // use existing datasource
    datasourceId = body.datasourceId
  }

  const importResult = await importer.importQueries(datasourceId)

  ctx.body = {
    ...importResult,
    datasourceId,
  }
  ctx.status = 200
}
export { _import as import }

export async function save(ctx: UserCtx<Query, Query>) {
  const db = context.getAppDB()
  const query: Query = ctx.request.body

  // Validate query name
  if (!query?.name.match(ValidQueryNameRegex)) {
    ctx.throw(400, "Invalid query name")
  }

  const datasource = await sdk.datasources.get(query.datasourceId)

  let eventFn
  if (!query._id) {
    query._id = generateQueryID(query.datasourceId)
    eventFn = () => events.query.created(datasource, query)
  } else {
    eventFn = () => events.query.updated(datasource, query)
  }
  const response = await db.put(query)
  await eventFn()
  query._rev = response.rev

  ctx.body = query
  ctx.message = `Query ${query.name} saved successfully.`
}

export async function find(ctx: UserCtx) {
  const queryId = ctx.params.queryId
  ctx.body = await sdk.queries.find(queryId)
}

//Required to discern between OIDC OAuth config entries
function getOAuthConfigCookieId(ctx: UserCtx) {
  if (ctx.user.providerType === ConfigType.OIDC) {
    return utils.getCookie(ctx, constants.Cookie.OIDC_CONFIG)
  }
}

function getAuthConfig(ctx: UserCtx) {
  const authCookie = utils.getCookie<SessionCookie>(ctx, constants.Cookie.Auth)
  let authConfigCtx: any = {}
  authConfigCtx["configId"] = getOAuthConfigCookieId(ctx)
  authConfigCtx["sessionId"] = authCookie ? authCookie.sessionId : null
  return authConfigCtx
}

function enrichParameters(
  queryParameters: QueryParameter[],
  requestParameters: { [key: string]: string } = {}
): {
  [key: string]: string
} {
  // make sure parameters are fully enriched with defaults
  for (let parameter of queryParameters) {
    if (!requestParameters[parameter.name]) {
      requestParameters[parameter.name] = parameter.default
    }
  }
  return requestParameters
}

export async function preview(
  ctx: UserCtx<PreviewQueryRequest, PreviewQueryResponse>
) {
  const { datasource, envVars } = await sdk.datasources.getWithEnvVars(
    ctx.request.body.datasourceId
  )
  // preview may not have a queryId as it hasn't been saved, but if it does
  // this stops dynamic variables from calling the same query
  const { fields, parameters, queryVerb, transformer, queryId, schema } =
    ctx.request.body

  let existingSchema = schema
  if (queryId && !existingSchema) {
    try {
      const db = context.getAppDB()
      const existing = (await db.get(queryId)) as Query
      existingSchema = existing.schema
    } catch (err: any) {
      if (err.status !== 404) {
        ctx.throw(500, "Unable to retrieve existing query")
      }
    }
  }

  const authConfigCtx: any = getAuthConfig(ctx)

  function getFieldMetadata(field: any, key: string): QuerySchema {
    const makeQuerySchema = (
      type: FieldType,
      name: string,
      subtype?: string
    ): QuerySchema => ({
      type,
      name,
      subtype,
    })
    // Because custom queries have no fixed schema, we dynamically determine the schema,
    // however types cannot be determined from null. We have no 'unknown' type, so we default to string.
    let type = typeof field,
      fieldMetadata = makeQuerySchema(FieldType.STRING, key)
    if (field != null)
      switch (type) {
        case "boolean":
          fieldMetadata = makeQuerySchema(FieldType.BOOLEAN, key)
          break
        case "object":
          if (field instanceof Date) {
            fieldMetadata = makeQuerySchema(FieldType.DATETIME, key)
          } else if (Array.isArray(field)) {
            if (field.some(item => JsonUtils.hasSchema(item))) {
              fieldMetadata = makeQuerySchema(
                FieldType.JSON,
                key,
                JsonFieldSubType.ARRAY
              )
            } else {
              fieldMetadata = makeQuerySchema(FieldType.ARRAY, key)
            }
          } else {
            fieldMetadata = makeQuerySchema(FieldType.JSON, key)
          }
          break
        case "number":
          fieldMetadata = makeQuerySchema(FieldType.NUMBER, key)
          break
      }
    return fieldMetadata
  }

  function buildNestedSchema(
    nestedSchemaFields: {
      [key: string]: Record<string, string | QuerySchema>
    },
    key: string,
    fieldArray: any[]
  ) {
    let schema: { [key: string]: any } = {}
    // build the schema by aggregating all row objects in the array
    for (const item of fieldArray) {
      if (JsonUtils.hasSchema(item)) {
        for (const [key, value] of Object.entries(item)) {
          schema[key] = getFieldMetadata(value, key)
        }
      }
    }
    nestedSchemaFields[key] = schema
  }

  function getSchemaFields(
    rows: any[],
    keys: string[]
  ): {
    previewSchema: Record<string, string | QuerySchema>
    nestedSchemaFields: {
      [key: string]: Record<string, string | QuerySchema>
    }
  } {
    const previewSchema: Record<string, string | QuerySchema> = {}
    const nestedSchemaFields: {
      [key: string]: Record<string, string | QuerySchema>
    } = {}
    if (rows?.length > 0) {
      for (let key of new Set(keys)) {
        const fieldMetadata = getFieldMetadata(rows[0][key], key)
        previewSchema[key] = fieldMetadata
        if (
          fieldMetadata.type === FieldType.JSON &&
          fieldMetadata.subtype === JsonFieldSubType.ARRAY
        ) {
          buildNestedSchema(nestedSchemaFields, key, rows[0][key])
        }
      }
    }
    return { previewSchema, nestedSchemaFields }
  }

  try {
    const inputs: QueryEvent = {
      appId: ctx.appId,
      datasource,
      queryVerb,
      fields,
      parameters: enrichParameters(parameters),
      transformer,
      queryId,
      schema,
      // have to pass down to the thread runner - can't put into context now
      environmentVariables: envVars,
      ctx: {
        user: ctx.user,
        auth: { ...authConfigCtx },
      },
    }

    const { rows, keys, info, extra } = await Runner.run<QueryResponse>(inputs)
    const { previewSchema, nestedSchemaFields } = getSchemaFields(rows, keys)

    // if existing schema, update to include any previous schema keys
    if (existingSchema) {
      for (let key of Object.keys(previewSchema)) {
        if (existingSchema[key]) {
          previewSchema[key] = existingSchema[key]
        }
      }
    }
    // remove configuration before sending event
    delete datasource.config
    await events.query.previewed(datasource, ctx.request.body)
    ctx.body = {
      rows,
      nestedSchemaFields,
      schema: previewSchema,
      info,
      extra,
    }
  } catch (err: any) {
    ctx.throw(400, err)
  }
}

async function execute(
  ctx: UserCtx<
    ExecuteQueryRequest,
    ExecuteQueryResponse | Record<string, any>[]
  >,
  opts: any = { rowsOnly: false, isAutomation: false }
) {
  const db = context.getAppDB()

  const query = await db.get<Query>(ctx.params.queryId)
  const { datasource, envVars } = await sdk.datasources.getWithEnvVars(
    query.datasourceId
  )

  let authConfigCtx: any = {}
  if (!opts.isAutomation) {
    authConfigCtx = getAuthConfig(ctx)
  }

  // call the relevant CRUD method on the integration class
  try {
    const inputs: QueryEvent = {
      appId: ctx.appId,
      datasource,
      queryVerb: query.queryVerb,
      fields: query.fields,
      pagination: ctx.request.body.pagination,
      parameters: enrichParameters(
        query.parameters,
        ctx.request.body.parameters
      ),
      transformer: query.transformer,
      queryId: ctx.params.queryId,
      // have to pass down to the thread runner - can't put into context now
      environmentVariables: envVars,
      ctx: {
        user: ctx.user,
        auth: { ...authConfigCtx },
      },
      schema: query.schema,
    }

    const { rows, pagination, extra, info } = await Runner.run<QueryResponse>(
      inputs
    )
    // remove the raw from execution incase transformer being used to hide data
    if (extra?.raw) {
      delete extra.raw
    }
    if (opts && opts.rowsOnly) {
      ctx.body = rows
    } else {
      ctx.body = { data: rows, pagination, ...extra, ...info }
    }
  } catch (err: any) {
    ctx.throw(400, err)
  }
}

export async function executeV1(
  ctx: UserCtx<ExecuteQueryRequest, Record<string, any>[]>
) {
  return execute(ctx, { rowsOnly: true, isAutomation: false })
}

export async function executeV2(
  ctx: UserCtx<
    ExecuteQueryRequest,
    ExecuteQueryResponse | Record<string, any>[]
  >,
  { isAutomation }: { isAutomation?: boolean } = {}
) {
  return execute(ctx, { rowsOnly: false, isAutomation })
}

const removeDynamicVariables = async (queryId: string) => {
  const db = context.getAppDB()
  const query = await db.get<Query>(queryId)
  const datasource = await sdk.datasources.get(query.datasourceId)
  const dynamicVariables = datasource.config?.dynamicVariables as any[]

  if (dynamicVariables) {
    // delete dynamic variables from the datasource
    datasource.config!.dynamicVariables = dynamicVariables!.filter(
      (dv: any) => dv.queryId !== queryId
    )
    await db.put(datasource)

    // invalidate the deleted variables
    const variablesToDelete = dynamicVariables!.filter(
      (dv: any) => dv.queryId === queryId
    )
    await invalidateDynamicVariables(variablesToDelete)
  }
}

export async function destroy(ctx: UserCtx) {
  const db = context.getAppDB()
  const queryId = ctx.params.queryId as string
  await removeDynamicVariables(queryId)
  const query = await db.get<Query>(queryId)
  const datasource = await sdk.datasources.get(query.datasourceId)
  await db.remove(ctx.params.queryId, ctx.params.revId)
  ctx.message = `Query deleted.`
  ctx.status = 200
  await events.query.deleted(datasource, query)
}
