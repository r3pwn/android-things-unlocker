import { NextResponse } from "next/server";

/**
 * Optional hardening shared by all API routes: when `UNLOCK_API_TOKEN`
 * is set, requests must carry `Authorization: Bearer <token>`.
 * Unset → open (the endpoints only ever return non-secret data).
 */
export function requireAuth(request: Request): NextResponse | null {
  const token = process.env.UNLOCK_API_TOKEN;
  if (!token) return null;
  if ((request.headers.get("authorization") ?? "") === `Bearer ${token}`) {
    return null;
  }
  return NextResponse.json(
    {
      ok: false,
      error: "UNAUTHORIZED",
      detail: "missing or invalid Authorization header",
    },
    { status: 401 },
  );
}
