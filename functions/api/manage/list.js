import {
    readIndex, mergeOperationsToIndex, deleteAllOperations, rebuildIndex,
    getIndexInfo, getIndexStorageStats
} from '../../utils/indexManager.js';
import { getDatabase } from '../../utils/databaseAdapter.js';
import { createMetadataViewContext, serializeFileRecordForManagement } from '../../utils/metadata/metadataView.js';
import { maybeCleanupExpiredFiles } from '../../utils/fileExpiryService.js';

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
    const { request, waitUntil } = context;
    const url = new URL(request.url);

    // 管理端打开文件列表时顺带清理一批到期文件（Pages 没有定时任务，依靠它和手动清理）
    maybeCleanupExpiredFiles(context);

    // 解析查询参数
    let start = parseInt(url.searchParams.get('start'), 10) || 0;
    let count = parseInt(url.searchParams.get('count'), 10) || 50;
    let sum = url.searchParams.get('sum') === 'true';
    let recursive = url.searchParams.get('recursive') === 'true';
    let dir = url.searchParams.get('dir') || '';
    let search = url.searchParams.get('search') || '';
    let channel = url.searchParams.get('channel') || '';
    let listType = url.searchParams.get('listType') || '';
    let accessStatus = url.searchParams.get('accessStatus') || '';
    let action = url.searchParams.get('action') || '';
    let includeTags = url.searchParams.get('includeTags') || '';
    let excludeTags = url.searchParams.get('excludeTags') || '';
    let label = url.searchParams.get('label') || '';
    let fileType = url.searchParams.get('fileType') || '';
    let channelName = url.searchParams.get('channelName') || '';

    // 处理搜索关键字
    if (search) {
        search = decodeURIComponent(search).trim();
    }

    // 处理标签参数
    const includeTagsArray = includeTags ? includeTags.split(',').map(t => t.trim()).filter(t => t) : [];
    const excludeTagsArray = excludeTags ? excludeTags.split(',').map(t => t.trim()).filter(t => t) : [];

    // 处理筛选参数（支持逗号分隔的多选）
    const listTypeArray = listType ? listType.split(',').map(t => t.trim()).filter(t => t) : [];
    const accessStatusArray = accessStatus ? accessStatus.split(',').map(t => t.trim()).filter(t => t) : [];
    const labelArray = label ? label.split(',').map(t => t.trim()).filter(t => t) : [];
    const fileTypeArray = fileType ? fileType.split(',').map(t => t.trim()).filter(t => t) : [];
    const channelArray = channel ? channel.split(',').map(t => t.trim()).filter(t => t) : [];
    const channelNameArray = channelName ? channelName.split(',').map(t => t.trim()).filter(t => t) : [];

    // 处理目录参数
    if (dir) {
        // 路径安全处理：防止路径穿越
        dir = dir.replace(/\.\./g, '_').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    }
    if (dir.startsWith('/')) {
        dir = dir.substring(1);
    }
    if (dir && !dir.endsWith('/')) {
        dir += '/';
    }

    try {
        // 特殊操作：重建索引
        if (action === 'rebuild') {
            waitUntil(rebuildIndex(context, (processed) => {
                console.log(`Rebuilt ${processed} files...`);
            }));

            return new Response('Index rebuilt asynchronously', {
                headers: { "Content-Type": "text/plain", ...corsHeaders }
            });
        }

        // 特殊操作：合并挂起的原子操作到索引
        if (action === 'merge-operations') {
            waitUntil(mergeOperationsToIndex(context));

            return new Response('Operations merged into index asynchronously', {
                headers: { "Content-Type": "text/plain", ...corsHeaders }
            });
        }

        // 特殊操作：清除所有原子操作
        if (action === 'delete-operations') {
            waitUntil(deleteAllOperations(context));

            return new Response('All operations deleted asynchronously', {
                headers: { "Content-Type": "text/plain", ...corsHeaders }
            });
        }

        // 特殊操作：获取索引存储信息
        if (action === 'index-storage-stats') {
            const stats = await getIndexStorageStats(context);
            return new Response(JSON.stringify(stats), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        }

        // 特殊操作：获取索引信息
        if (action === 'info') {
            const info = await getIndexInfo(context, {
                timezoneOffset: url.searchParams.get('timezoneOffset'),
                maxPoints: url.searchParams.get('trendMaxPoints'),
                seriesLimit: url.searchParams.get('trendSeriesLimit'),
                startDate: url.searchParams.get('trendStartDate'),
                endDate: url.searchParams.get('trendEndDate')
            });
            return new Response(JSON.stringify(info), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        }

        // 普通查询：只返回总数
        if (count === -1 && sum) {
            const result = await readIndex(context, {
                search,
                directory: dir,
                channel: channelArray,
                listType: listTypeArray,
                accessStatus: accessStatusArray,
                label: labelArray,
                fileType: fileTypeArray,
                channelName: channelNameArray,
                includeTags: includeTagsArray,
                excludeTags: excludeTagsArray,
                countOnly: true
            });

            // countOnly 成功时没有 success 字段；只有读取失败才是 success === false
            const total = result.success === false
                ? await countFilesWithoutIndex(context, { dir, search })
                : result.totalCount;

            return new Response(JSON.stringify({
                sum: total,
                indexLastUpdated: result.success === false ? Date.now() : result.indexLastUpdated
            }), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        }

        // 普通查询：返回数据
        const result = await readIndex(context, {
            search,
            directory: dir,
            start,
            count,
            channel: channelArray,
            listType: listTypeArray,
            accessStatus: accessStatusArray,
            label: labelArray,
            fileType: fileTypeArray,
            channelName: channelNameArray,
            includeTags: includeTagsArray,
            excludeTags: excludeTagsArray,
            includeSubdirFiles: recursive,
        });

        // 索引不可用时按目录直接查询，只取当前页
        if (!result.success) {
            const dbRecords = await listFilesWithoutIndex(context, {
                dir,
                start,
                count,
                recursive,
                search,
            });

            return new Response(JSON.stringify({
                files: dbRecords.files,
                directories: dbRecords.directories,
                totalCount: dbRecords.totalCount,
                directFileCount: dbRecords.directFileCount,
                directFolderCount: dbRecords.directFolderCount,
                returnedCount: dbRecords.returnedCount,
                indexLastUpdated: Date.now(),
                isIndexedResponse: false // 标记这是未走索引的响应
            }), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        }

        const db = getDatabase(context.env);
        const metadataViewContext = await createMetadataViewContext(db, context.env);

        // 转换文件格式
        const compatibleFiles = await Promise.all(
            result.files.map(file => serializeFileRecordForManagement(db, context.env, file, metadataViewContext))
        );

        return new Response(JSON.stringify({
            files: compatibleFiles,
            directories: result.directories,
            totalCount: result.totalCount,
            directFileCount: result.directFileCount,
            directFolderCount: result.directFolderCount,
            returnedCount: result.returnedCount,
            indexLastUpdated: result.indexLastUpdated,
            isIndexedResponse: true // 标记这是来自索引的响应
        }), {
            headers: { "Content-Type": "application/json", ...corsHeaders }
        });

    } catch (error) {
        console.error('Error in list-indexed API:', error);
        return new Response(JSON.stringify({
            error: 'Internal server error',
            message: error.message
        }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders }
        });
    }
}

async function countFilesWithoutIndex(context, { dir, search }) {
    const listed = await queryFileListing(context, {
        dir,
        search,
        start: 0,
        count: -1,
        recursive: true,
        countOnly: true,
    });
    return listed.totalCount;
}

async function listFilesWithoutIndex(context, options) {
    const db = getDatabase(context.env);
    const listed = await queryFileListing(context, options);
    const metadataViewContext = await createMetadataViewContext(db, context.env);
    const files = await Promise.all(listed.files.map(file =>
        serializeFileRecordForManagement(db, context.env, file, metadataViewContext)
    ));
    return { ...listed, files };
}

async function queryFileListing(context, { dir, start, count, recursive, search, countOnly = false }) {
    const db = getDatabase(context.env);
    if (typeof db.queryDirectoryListing === 'function') {
        return db.queryDirectoryListing({
            directory: dir,
            start,
            count,
            recursive,
            search,
            countOnly,
        });
    }
    return scanFileRecords(db, dir, { start, count, recursive, search, countOnly });
}

// KV 没有目录列，只能按键前缀扫描。D1 走 queryDirectoryListing，不会进这里。
async function scanFileRecords(db, dir, { start = 0, count = -1, recursive = false, search = '', countOnly = false }) {
    const allRecords = [];
    let cursor = null;
    const needle = search ? search.toLowerCase() : '';

    try {
        while (true) {
            const response = await db.list({
                prefix: dir,
                limit: 1000,
                cursor: cursor
            });

            if (!response || !response.keys || !Array.isArray(response.keys)) {
                console.error('Invalid response from database list:', response);
                break;
            }

            cursor = response.cursor;

            for (const item of response.keys) {
                if (item.name.startsWith('manage@') || item.name.startsWith('chunk_')) {
                    continue;
                }
                if (!item.metadata || !item.metadata.TimeStamp) {
                    continue;
                }
                if (needle) {
                    const fileName = item.metadata.FileName || '';
                    if (!item.name.toLowerCase().includes(needle) && !fileName.toLowerCase().includes(needle)) {
                        continue;
                    }
                }
                allRecords.push({ id: item.name, metadata: item.metadata });
            }

            if (!cursor) break;
            await new Promise(resolve => setTimeout(resolve, 10));
        }

        const directories = new Set();
        const directRecords = [];
        allRecords.forEach(item => {
            const subDir = item.id.substring(dir.length);
            const firstSlashIndex = subDir.indexOf('/');
            if (firstSlashIndex !== -1) {
                directories.add(dir + subDir.substring(0, firstSlashIndex));
            } else {
                directRecords.push(item);
            }
        });

        let resultFiles = recursive ? allRecords : directRecords;
        if (!countOnly && count !== -1) {
            const startIndex = Math.max(0, start);
            resultFiles = resultFiles.slice(startIndex, startIndex + Math.max(0, count));
        }
        if (countOnly) {
            resultFiles = [];
        }

        return {
            files: resultFiles,
            directories: Array.from(directories),
            totalCount: allRecords.length,
            directFileCount: directRecords.length,
            directFolderCount: directories.size,
            returnedCount: resultFiles.length
        };
    } catch (error) {
        console.error('Error in scanFileRecords:', error);
        return {
            files: [],
            directories: [],
            totalCount: 0,
            directFileCount: 0,
            directFolderCount: 0,
            returnedCount: 0,
            error: error.message
        };
    }
}
