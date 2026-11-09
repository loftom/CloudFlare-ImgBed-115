/** 目录路径 → 前端路由。每段单独编码，保留中文/空格/特殊字符 */
export function dirToRoute(dir: string): string {
  if (!dir) return '/';
  return '/d/' + dir.split('/').map(encodeURIComponent).join('/');
}

/** 前端路由 pathname → 目录路径 */
export function routeToDir(pathname: string): string {
  if (!pathname.startsWith('/d/')) return '';
  return pathname
    .slice(3)
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join('/');
}

export function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

export function breadcrumbs(dir: string): { name: string; path: string }[] {
  const parts = dir.split('/').filter(Boolean);
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
}

export function formatBytes(n: number | null): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
