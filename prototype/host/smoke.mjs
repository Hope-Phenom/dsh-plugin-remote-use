// smoke: can the ACP SDK be imported and are the pieces the prototype needs present?
import * as acp from '@agentclientprotocol/sdk'
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client'

console.log('acp exports:', Object.keys(acp).sort().join(', '))
console.log('methods.agent keys:', Object.keys(acp.methods.agent).join(', '))
console.log('methods.client keys:', Object.keys(acp.methods.client).join(', '))
console.log('PROTOCOL_VERSION =', acp.PROTOCOL_VERSION)
console.log('client is fn =', typeof acp.client)
console.log('createWebSocketStream is fn =', typeof createWebSocketStream)
