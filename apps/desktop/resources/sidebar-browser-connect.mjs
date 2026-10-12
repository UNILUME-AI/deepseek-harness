// Playwright MCP's extension mode launches the stand-in with its connection page URL. The script
// hands the relay URL to the desktop shell over DSH_SIDEBAR_BROWSER_SOCKET and waits at most
// DSH_SIDEBAR_BROWSER_CONNECT_TIMEOUT_MS for the shell to accept it. When the shell refuses, is
// absent, or misses the deadline, the script connects to the relay and closes it with the reason,
// which fails the upstream wait instead of leaving it pending. The relay URL path is the relay's
// only credential: never print it.
import { connect } from 'node:net'

const page = process.argv.slice(2).filter(arg => URL.canParse(arg)).map(arg => new URL(arg))
  .find(url => url.protocol === 'chrome-extension:')
const relayUrl = page?.searchParams.get('mcpRelayUrl')
if (relayUrl === null || relayUrl === undefined) process.exit(2)

const timeoutMs = Number(process.env.DSH_SIDEBAR_BROWSER_CONNECT_TIMEOUT_MS)

/** @returns undefined when the shell accepted the relay, otherwise the refusal reason. */
function handOff() {
  return new Promise((resolve) => {
    const socket = connect(process.env.DSH_SIDEBAR_BROWSER_SOCKET ?? '')
    const timer = setTimeout(() => { finish('sidebar browser: the desktop shell did not accept the connection in time') }, timeoutMs)
    let reply = ''
    function finish(reason) {
      clearTimeout(timer)
      socket.destroy()
      resolve(reason)
    }
    socket.setEncoding('utf8')
    socket.on('connect', () => { socket.write(`${JSON.stringify({ relayUrl, token: process.env.DSH_SIDEBAR_BROWSER_TOKEN })}\n`) })
    socket.on('data', (chunk) => {
      reply += chunk
      const end = reply.indexOf('\n')
      if (end === -1) return
      let answer
      try {
        answer = JSON.parse(reply.slice(0, end))
      } catch (_error) {
        // A malformed reply is a refusal; its text is not trusted for display.
        finish('sidebar browser: the desktop shell sent an invalid reply')
        return
      }
      finish(answer.ok === true ? undefined : typeof answer.error === 'string' ? answer.error : 'sidebar browser: connection refused')
    })
    socket.on('error', () => { finish('sidebar browser: the desktop shell is not listening') })
    socket.on('close', () => { finish('sidebar browser: the desktop shell closed the connection') })
  })
}

const refusal = await handOff()
if (refusal !== undefined) {
  const relay = new WebSocket(relayUrl)
  relay.onopen = () => { relay.close(1000, refusal.slice(0, 120)) }
  relay.onclose = () => { process.exit(1) }
  relay.onerror = () => { process.exit(1) }
}
