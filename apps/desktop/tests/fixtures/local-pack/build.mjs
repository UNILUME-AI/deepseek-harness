import { copyFile, mkdir } from 'node:fs/promises'

await mkdir(new URL('./lib/', import.meta.url), { recursive: true })
await Promise.all(['index.js', 'client.js'].map(file => copyFile(
  new URL(`./src/${file}`, import.meta.url),
  new URL(`./lib/${file}`, import.meta.url),
)))
