import {
  HttpError, json, errorResponse, sanitizePath, getAllowedDirs, isDirAllowed, listDirectory,
} from '../_lib/common.js';

const MAX_DEPTH = 3;
const PROBE = 12;

/**
 * GET /api/cover?dir=BBB/合集A/套图01
 * 封面 = 该目录（按上传顺序）第一张图片；目录下没有直接图片时，沿第一个子目录向下找，最多 3 层。
 * 返回：{ dir, cover: {path,name,...} | null, directFileCount, childCount }
 */
export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const dir = sanitizePath(url.searchParams.get('dir') || '', { allowEmpty: false });
    const allowed = getAllowedDirs(context.env);
    if (!isDirAllowed(dir, allowed)) throw new HttpError(403, '该目录不在允许范围内');

    let current = dir;
    let first = null;
    let cover = null;
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      const r = await listDirectory(context.env, { dir: current, start: 0, count: PROBE, order: 'asc', totalHint: NaN });
      if (!first) first = r;
      cover = r.files.find((f) => f.kind === 'image' && !f.blocked) || r.files.find((f) => f.kind === 'image') || null;
      if (cover || !r.directories.length) break;
      current = r.directories[0].path;
    }
    return json(
      {
        dir,
        cover,
        directFileCount: first?.directFileCount ?? 0,
        childCount: first?.directories.length ?? 0,
      },
      200,
      { 'Cache-Control': 'private, max-age=86400' },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
