# Meeting Room Booking MCP server

Node.js 20+ MCP server using the official SDK and Streamable HTTP transport.
It exposes public room discovery tools and OAuth-protected personal booking tools.

## Setup

1. Run `npm install`.
2. Copy `.env.example` to `.env` and configure the Laravel API and public MCP URLs.
3. Install/configure Laravel Passport and create a public PKCE client for ChatGPT.
4. Run `npm run check` to check syntax.

## Configuration

```env
API_BASE_URL=https://meeting.example.com/api
AUTHORIZATION_SERVER_URL=https://meeting.example.com
MCP_PUBLIC_URL=https://mcp.example.com/mcp
HOST=0.0.0.0
PORT=8000
```

Expose `MCP_PUBLIC_URL` through HTTPS. The OAuth protected-resource metadata is available at
`/.well-known/oauth-protected-resource`.

Room listing, booking reasons, and availability are public. Personal booking tools require the
`meeting:read` or `meeting:write` OAuth scopes. The MCP server validates the token through
Laravel and forwards the same user-bound token to the meeting API.
