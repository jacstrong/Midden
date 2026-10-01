import { cp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const websiteRoot = path.resolve(__dirname, '..')
const sourceDocsDir = path.resolve(websiteRoot, '..', 'docs')
const outputDocsDir = path.resolve(websiteRoot, 'site', 'docs')

await rm(outputDocsDir, { recursive: true, force: true })
await mkdir(path.dirname(outputDocsDir), { recursive: true })
await cp(sourceDocsDir, outputDocsDir, { recursive: true })
