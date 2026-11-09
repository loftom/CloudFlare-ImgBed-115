import { json, errorResponse, getOrigin, getAllowedDirs, isTruthy } from '../_lib/common.js';

/**
 * GET /api/config：前端启动时读取。只暴露公开信息（图片基址），绝不包含 Token。
 * IMAGE_PROXY=true 时 imageBase 为空串，图片走同源 /file/* 代理；否则浏览器直连 ImgBed /file/*。
 */
export async function onRequestGet(context) {
  try {
    const proxy = isTruthy(context.env.IMAGE_PROXY);
    const origin = getOrigin(context.env);
    return json(
      {
        imageBase: proxy ? '' : origin,
        imageProxy: proxy,
        allowedDirs: getAllowedDirs(context.env),
        title: String(context.env.GALLERY_TITLE || '私人图库'),
      },
      200,
      { 'Cache-Control': 'private, max-age=60' },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
