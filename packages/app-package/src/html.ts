/** HTML the app's CSP refuses at run time (inline or remote code, inline handlers, `<base>`). */
export function htmlProblems(html: string): string[] {
  const problems: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? "";
    const src = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1];
    if (!src && (match[2] ?? "").trim())
      problems.push("inline <script> (blocked: move the code into a bundled file)");
    if (src && /^(?:[a-z]+:)?\/\//i.test(src))
      problems.push(`remote script ${src} (blocked: bundle it with the app)`);
  }
  for (const match of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']?([^"'\s>]+)/gi))
    if (/^(?:[a-z]+:)?\/\//i.test(match[1] ?? ""))
      problems.push(`remote resource ${match[1]} (blocked: apps load their own files only)`);
  if (/\son[a-z]+\s*=/i.test(html.replace(/<script[\s\S]*?<\/script>/gi, "")))
    problems.push("inline event handler attribute (blocked: add listeners in code)");
  if (/<base\b/i.test(html)) problems.push("<base> element (blocked)");
  return problems;
}
