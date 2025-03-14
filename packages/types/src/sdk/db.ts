import type Nano from "@budibase/nano"
import {
  AllDocsResponse,
  AnyDocument,
  Document,
  RowValue,
  ViewTemplateOpts,
} from "../"
import { Writable } from "stream"

export enum SearchIndex {
  ROWS = "rows",
  AUDIT = "audit",
  USER = "user",
}

export type PouchOptions = {
  inMemory?: boolean
  replication?: boolean
  onDisk?: boolean
  find?: boolean
}

export enum SortOption {
  ASCENDING = "asc",
  DESCENDING = "desc",
}

export type IndexAnalyzer = {
  name: string
  default?: string
  fields?: Record<string, string>
}

export type DBView = {
  name?: string
  map: string
  reduce?: string
  meta?: ViewTemplateOpts
  groupBy?: string
}

export interface DesignDocument extends Document {
  // we use this static reference for all design documents
  _id: "_design/database"
  language?: string
  // CouchDB views
  views?: {
    [viewName: string]: DBView
  }
  // Lucene indexes
  indexes?: {
    [indexName: string]: {
      index: string
      analyzer?: string | IndexAnalyzer
    }
  }
}

export type CouchFindOptions = {
  selector: PouchDB.Find.Selector
  fields?: string[]
  sort?: {
    [key: string]: SortOption
  }[]
  limit?: number
  skip?: number
  bookmark?: string
}

export type DatabaseOpts = {
  skip_setup?: boolean
}

export type DatabasePutOpts = {
  force?: boolean
}

export type DatabaseCreateIndexOpts = {
  index: {
    fields: string[]
    name?: string | undefined
    ddoc?: string | undefined
    type?: string | undefined
  }
}

export type DatabaseDeleteIndexOpts = {
  name: string
  ddoc: string
  type?: string | undefined
}

type DBPrimitiveKey = string | number | {}
export type DatabaseKey = DBPrimitiveKey | DBPrimitiveKey[]

export type DatabaseQueryOpts = {
  include_docs?: boolean
  startkey?: DatabaseKey
  endkey?: DatabaseKey
  limit?: number
  skip?: number
  descending?: boolean
  key?: DatabaseKey
  keys?: DatabaseKey[]
  group?: boolean
  startkey_docid?: string
}

export const isDocument = (doc: any): doc is Document => {
  return typeof doc === "object" && doc._id && doc._rev
}

export interface DatabaseDumpOpts {
  filter?: (doc: AnyDocument) => boolean
  batch_size?: number
  batch_limit?: number
  style?: "main_only" | "all_docs"
  timeout?: number
  doc_ids?: string[]
  query_params?: any
  view?: string
  selector?: any
}

export interface Database {
  name: string

  exists(): Promise<boolean>
  get<T extends Document>(id?: string): Promise<T>
  getMultiple<T extends Document>(
    ids: string[],
    opts?: { allowMissing?: boolean }
  ): Promise<T[]>
  remove(
    id: string | Document,
    rev?: string
  ): Promise<Nano.DocumentDestroyResponse>
  put(
    document: AnyDocument,
    opts?: DatabasePutOpts
  ): Promise<Nano.DocumentInsertResponse>
  bulkDocs(documents: AnyDocument[]): Promise<Nano.DocumentBulkResponse[]>
  allDocs<T extends Document | RowValue>(
    params: DatabaseQueryOpts
  ): Promise<AllDocsResponse<T>>
  query<T extends Document>(
    viewName: string,
    params: DatabaseQueryOpts
  ): Promise<AllDocsResponse<T>>
  destroy(): Promise<Nano.OkResponse | void>
  compact(): Promise<Nano.OkResponse | void>
  // these are all PouchDB related functions that are rarely used - in future
  // should be replaced by better typed/non-pouch implemented methods
  dump(stream: Writable, opts?: DatabaseDumpOpts): Promise<any>
  load(...args: any[]): Promise<any>
  createIndex(...args: any[]): Promise<any>
  deleteIndex(...args: any[]): Promise<any>
  getIndexes(...args: any[]): Promise<any>
}
