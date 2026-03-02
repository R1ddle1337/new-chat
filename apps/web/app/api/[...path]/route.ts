import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const gatewayBaseUrl = process.env.GATEWAY_URL_INTERNAL ?? 'http://localhost:3001';

function buildTargetUrl(request: NextRequest, pathSegments: string[]): string {
  const path = pathSegments.join('/');
  const query = request.nextUrl.search;
  return `${gatewayBaseUrl}/${path}${query}`;
}

async function proxy(request: NextRequest, pathSegments: string[]): Promise<Response> {
  const target = buildTargetUrl(request, pathSegments);
  const headers = new Headers(request.headers);
  headers.delete('host');

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = request.body;
    init.duplex = 'half';
  }

  const upstream = await fetch(target, init);
  const responseHeaders = new Headers(upstream.headers);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

async function handleRequest(
  request: NextRequest,
  context: { params: { path: string[] } },
): Promise<Response> {
  try {
    return await proxy(request, context.params.path ?? []);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Proxy failed' },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest, context: { params: { path: string[] } }) {
  return handleRequest(request, context);
}

export async function HEAD(request: NextRequest, context: { params: { path: string[] } }) {
  return handleRequest(request, context);
}

export async function OPTIONS(request: NextRequest, context: { params: { path: string[] } }) {
  return handleRequest(request, context);
}

export async function POST(request: NextRequest, context: { params: { path: string[] } }) {
  return handleRequest(request, context);
}

export async function PUT(request: NextRequest, context: { params: { path: string[] } }) {
  return handleRequest(request, context);
}

export async function PATCH(request: NextRequest, context: { params: { path: string[] } }) {
  return handleRequest(request, context);
}

export async function DELETE(request: NextRequest, context: { params: { path: string[] } }) {
  return handleRequest(request, context);
}
