import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Skip static files, the public widget, public APIs and webhooks (they do their own auth).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|widget.js|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
