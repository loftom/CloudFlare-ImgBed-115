/**
 * D1 数据库操作工具类
 */

class D1Database {
    constructor(db) {
        this.db = db;
    }
}

// ==================== 文件操作 ====================

/**
 * 保存文件记录 (替代 KV.put)
 */
D1Database.prototype.putFile = function(fileId, value, options) {
    value = value || '';
    options = options || {};
    var metadata = options.metadata || {};
    
    // 从metadata中提取字段用于索引
    var extractedFields = this.extractMetadataFields(metadata);
    
    var stmt = this.db.prepare(
        'INSERT OR REPLACE INTO files (' +
        'id, value, metadata, file_name, file_type, file_size, ' +
        'upload_ip, upload_address, list_type, timestamp, ' +
        'label, directory, channel, channel_name, ' +
        'tg_file_id, tg_chat_id, tg_bot_token, is_chunked' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    
    return stmt.bind(
        fileId,
        value,
        JSON.stringify(metadata),
        extractedFields.fileName,
        extractedFields.fileType,
        extractedFields.fileSize,
        extractedFields.uploadIP,
        extractedFields.uploadAddress,
        extractedFields.listType,
        extractedFields.timestamp,
        extractedFields.label,
        extractedFields.directory,
        extractedFields.channel,
        extractedFields.channelName,
        extractedFields.tgFileId,
        extractedFields.tgChatId,
        extractedFields.tgBotToken,
        extractedFields.isChunked
    ).run();
};

/**
 * 获取文件记录 (替代 KV.get)
 */
D1Database.prototype.getFile = function(fileId) {
    var self = this;
    var stmt = this.db.prepare('SELECT * FROM files WHERE id = ?');
    return stmt.bind(fileId).first().then(function(result) {
        if (!result) return null;
        
        return {
            value: result.value,
            metadata: JSON.parse(result.metadata || '{}')
        };
    });
};

/**
 * 获取文件记录包含元数据 (替代 KV.getWithMetadata)
 */
D1Database.prototype.getFileWithMetadata = function(fileId) {
    return this.getFile(fileId);
};

/**
 * 删除文件记录 (替代 KV.delete)
 */
D1Database.prototype.deleteFile = function(fileId) {
    var stmt = this.db.prepare('DELETE FROM files WHERE id = ?');
    return stmt.bind(fileId).run();
};

/**
 * 列出文件 (替代 KV.list)
 */
D1Database.prototype.listFiles = function(options) {
    options = options || {};
    var prefix = options.prefix || '';
    var limit = options.limit || 1000;
    var cursor = options.cursor || null;
    
    var query = 'SELECT id, metadata FROM files';
    var params = [];
    
    if (prefix) {
        query += ' WHERE id LIKE ?';
        params.push(prefix + '%');
    }
    
    if (cursor) {
        query += prefix ? ' AND' : ' WHERE';
        query += ' id > ?';
        params.push(cursor);
    }
    
    query += ' ORDER BY id LIMIT ?';
    params.push(limit + 1);
    
    var stmt = this.db.prepare(query);
    if (params.length > 0) {
        stmt = stmt.bind.apply(stmt, params);
    }
    return stmt.all().then(function(response) {
        var results = response.results || [];
        var hasMore = results.length > limit;
        if (hasMore) {
            results.pop();
        }

        var keys = results.map(function(row) {
            return {
                name: row.id,
                metadata: JSON.parse(row.metadata || '{}')
            };
        });
        
        return {
            keys: keys,
            cursor: hasMore && keys.length > 0 ? keys[keys.length - 1].name : null,
            list_complete: !hasMore
        };
    });
};

/**
 * 列出已到期的文件，按到期时间升序；跳过删除失败后仍在等待重试的文件
 * 条件必须与 idx_files_expires 的表达式一致才能走索引，只读取已到期的行
 */
D1Database.prototype.listExpiredFiles = function(now, limit) {
    var stmt = this.db.prepare(
        "SELECT id, value, metadata FROM files WHERE json_extract(metadata, '$.ExpiresAt') <= ? " +
        "AND COALESCE(json_extract(metadata, '$.ExpiryCleanupRetryAt'), 0) <= ? " +
        "ORDER BY json_extract(metadata, '$.ExpiresAt') LIMIT ?"
    );
    return stmt.bind(now, now, limit).all().then(function(response) {
        return (response.results || []).map(function(row) {
            return {
                id: row.id,
                value: row.value,
                metadata: JSON.parse(row.metadata || '{}')
            };
        });
    });
};

/**
 * 仅当记录仍是确认时的版本（到期时间和上传时间都相同）才删除（有效期清理用），返回是否已删除
 * 记录在清理期间被续期、改为永久或被同名上传替换时保留
 */
D1Database.prototype.deleteExpiredFileIfUnchanged = function(fileId, expiresAt, timeStamp) {
    var stmt = this.db.prepare(
        "DELETE FROM files WHERE id = ? AND json_extract(metadata, '$.ExpiresAt') = ? " +
        "AND json_extract(metadata, '$.TimeStamp') IS ?"
    );
    return stmt.bind(fileId, expiresAt, timeStamp === undefined ? null : timeStamp).run().then(function(result) {
        return Boolean(result && result.meta && result.meta.changes > 0);
    });
};

/**
 * 删除失败的到期文件推迟到 retryAt 再处理，避免持续失败的文件一直占据每次清理的批次
 * 只在记录仍是确认时的版本（到期时间和上传时间相同）时写入
 */
D1Database.prototype.deferExpiredFileCleanup = function(fileId, expiresAt, timeStamp, retryAt) {
    var stmt = this.db.prepare(
        "UPDATE files SET metadata = json_set(metadata, '$.ExpiryCleanupRetryAt', ?) " +
        "WHERE id = ? AND json_extract(metadata, '$.ExpiresAt') = ? AND json_extract(metadata, '$.TimeStamp') IS ?"
    );
    return stmt.bind(retryAt, fileId, expiresAt, timeStamp === undefined ? null : timeStamp).run();
};

/**
 * 统计当前可以清理的文件数：已到期，且不在删除失败后的重试等待中（条件与 listExpiredFiles 一致）
 */
D1Database.prototype.countExpiredFiles = function(now) {
    var stmt = this.db.prepare(
        "SELECT COUNT(*) AS count FROM files WHERE json_extract(metadata, '$.ExpiresAt') <= ? " +
        "AND COALESCE(json_extract(metadata, '$.ExpiryCleanupRetryAt'), 0) <= ?"
    );
    return stmt.bind(now, now).first().then(function(result) {
        return result ? Number(result.count) : 0;
    });
};

/**
 * files 里可被列表看到的行是否已经超过 offset。
 * offset 用分块索引 meta 声称的数量（生产上是一万多，不是整库一百万）。
 * 多出来就说明分块索引不能代表目录，调用方不应再读或合并分块。
 * 结果记在 D1 绑定上：确认超出后保留 10 分钟，确认没有超出只保留 20 秒，
 * 这样新上传很快会改走 SQL，而百万行目录不会每个请求都再探一次。
 */
D1Database.prototype.catalogHasMoreThan = function(count) {
    var offset = Math.max(0, parseInt(count, 10) || 0);
    var now = Date.now();
    var bucket = cacheBucket(catalogProbeCache, this.db);
    var cachedOffsets = Array.from(bucket.keys());
    for (var i = 0; i < cachedOffsets.length; i++) {
        var cachedOffset = cachedOffsets[i];
        var entry = bucket.get(cachedOffset);
        if (!entry || now > entry.expires) {
            bucket.delete(cachedOffset);
            continue;
        }
        if (entry.more && offset <= cachedOffset) {
            return Promise.resolve(true);
        }
        if (!entry.more && offset >= cachedOffset) {
            return Promise.resolve(false);
        }
    }

    var stmt = this.db.prepare(
        "SELECT 1 AS present FROM files WHERE timestamp IS NOT NULL AND id NOT GLOB 'chunk_*' LIMIT 1 OFFSET ?"
    );
    return stmt.bind(offset).first().then(function(row) {
        var more = !!(row && row.present != null);
        bucket.set(offset, {
            more: more,
            expires: now + (more ? CATALOG_PROBE_MORE_TTL_MS : CATALOG_PROBE_FRESH_TTL_MS)
        });
        return more;
    }).catch(function() {
        // 探测失败时当作目录已经超出索引，避免再去合并分块。
        return true;
    });
};

/**
 * 管理端目录分页。
 * 非递归页只按 directory = ? 走 idx_files_directory_timestamp，取 LIMIT 行，不再把整个目录的 metadata 放进临时排序。
 * 根目录文件的 directory 列是 NULL，另外兼容历史上写成空字符串的行；两段等值查找后在 Worker 里按时间合并。
 * 子目录用前缀跳查，不把目录下每个文件都扫一遍。计数是索引范围上的 COUNT，并在同一个 D1 绑定上缓存约 20 秒。
 * count 为 -1 时仍返回该目录下的全部直接文件（或 recursive 时的全部文件），文件夹删除/移动依赖这一点。
 * countOnly 只统计，供 sum=true 使用。
 * 计数若因 D1 过载失败，已经取到的这一页仍然返回，countsUnavailable 为 true，数字只是下界。
 */
D1Database.prototype.queryDirectoryListing = async function(options) {
    options = options || {};
    var directory = normalizeListingDirectory(options.directory);
    var start = Math.max(0, parseInt(options.start, 10) || 0);
    var countValue = options.count == null ? 50 : Number(options.count);
    var unlimited = countValue === -1;
    var limit = unlimited ? 0 : (Number.isFinite(countValue) ? Math.max(0, countValue) : 50);
    var recursive = !!options.recursive;
    var search = options.search ? String(options.search).trim() : '';
    var countOnly = !!options.countOnly;

    if (countOnly) {
        var onlyCounts = await readListingCounts(this.db, directory, search);
        // sum=true 只有一个数字。计数被拒绝时不能把下界当成全库总数。
        if (onlyCounts.countsUnavailable) {
            throw new Error('D1 DB is overloaded');
        }
        return {
            files: [],
            directories: [],
            totalCount: onlyCounts.totalCount,
            directFileCount: onlyCounts.directFileCount,
            directFolderCount: 0,
            returnedCount: 0
        };
    }

    // 先取当前页和子目录。这两条走索引，应在计数之前完成，避免和全库 COUNT 抢同一段 D1 时间。
    var files = await listDirectoryFiles(this.db, directory, search, recursive, unlimited, limit, start);
    var directories = await listChildDirectories(this.db, directory, search);
    var counts;
    try {
        counts = await readListingCounts(this.db, directory, search);
    } catch (error) {
        if (!isDatabaseOverload(error)) {
            throw error;
        }
        counts = lowerBoundCounts(files, start, limit, unlimited);
    }

    var listed = {
        files: files,
        directories: directories,
        totalCount: counts.totalCount,
        directFileCount: counts.directFileCount,
        directFolderCount: directories.length,
        returnedCount: files.length
    };
    if (counts.countsUnavailable) {
        listed.countsUnavailable = true;
        if (Number(listed.totalCount) < listed.directFileCount) {
            listed.totalCount = listed.directFileCount;
        }
    }
    return listed;
};

// ==================== 设置操作 ====================

/**
 * 保存设置 (替代 KV.put)
 */
D1Database.prototype.putSetting = function(key, value, category) {
    if (!category && key.startsWith('manage@sysConfig@')) {
        category = key.split('@')[2];
    }
    
    var stmt = this.db.prepare(
        'INSERT OR REPLACE INTO settings (key, value, category) VALUES (?, ?, ?)'
    );
    
    return stmt.bind(key, value, category).run();
};

/**
 * 获取设置 (替代 KV.get)
 */
D1Database.prototype.getSetting = function(key) {
    var stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    return stmt.bind(key).first().then(function(result) {
        return result ? result.value : null;
    });
};

/**
 * 删除设置 (替代 KV.delete)
 */
D1Database.prototype.deleteSetting = function(key) {
    var stmt = this.db.prepare('DELETE FROM settings WHERE key = ?');
    return stmt.bind(key).run();
};

/**
 * 列出设置 (替代 KV.list)
 */
D1Database.prototype.listSettings = function(options) {
    options = options || {};
    var prefix = options.prefix || '';
    var limit = options.limit || 1000;
    var cursor = options.cursor || null;

    var query = 'SELECT key, value FROM settings';
    var params = [];

    if (prefix) {
        query += ' WHERE key LIKE ?';
        params.push(prefix + '%');
    }

    // 与 listFiles 一致返回 cursor，否则超过 limit 的键（如大量会话）会让后面的设置永远读不到
    if (cursor) {
        query += prefix ? ' AND' : ' WHERE';
        query += ' key > ?';
        params.push(cursor);
    }

    query += ' ORDER BY key LIMIT ?';
    params.push(limit + 1);

    var stmt = this.db.prepare(query);
    if (params.length > 0) {
        stmt = stmt.bind.apply(stmt, params);
    }
    return stmt.all().then(function(response) {
        var results = response.results || [];
        var hasMore = results.length > limit;
        if (hasMore) {
            results.pop();
        }

        var keys = results.map(function(row) {
            return {
                name: row.key,
                value: row.value
            };
        });

        return {
            keys: keys,
            cursor: hasMore && keys.length > 0 ? keys[keys.length - 1].name : null,
            list_complete: !hasMore
        };
    });
};

// ==================== 索引操作 ====================

/**
 * 保存索引操作记录
 */
D1Database.prototype.putIndexOperation = function(operationId, operation) {
    var stmt = this.db.prepare(
        'INSERT OR REPLACE INTO index_operations (id, type, timestamp, data) VALUES (?, ?, ?, ?)'
    );
    
    return stmt.bind(
        operationId,
        operation.type,
        operation.timestamp,
        JSON.stringify(operation.data)
    ).run();
};

/**
 * 获取索引操作记录
 */
D1Database.prototype.getIndexOperation = function(operationId) {
    var stmt = this.db.prepare('SELECT * FROM index_operations WHERE id = ?');
    return stmt.bind(operationId).first().then(function(result) {
        if (!result) return null;
        
        return {
            type: result.type,
            timestamp: result.timestamp,
            data: JSON.parse(result.data)
        };
    });
};

/**
 * 删除索引操作记录
 */
D1Database.prototype.deleteIndexOperation = function(operationId) {
    var stmt = this.db.prepare('DELETE FROM index_operations WHERE id = ?');
    return stmt.bind(operationId).run();
};

/**
 * 列出索引操作记录
 */
D1Database.prototype.listIndexOperations = function(options) {
    options = options || {};
    var limit = options.limit || 1000;
    var processed = options.processed;
    
    var query = 'SELECT * FROM index_operations';
    var params = [];
    
    if (processed !== null && processed !== undefined) {
        query += ' WHERE processed = ?';
        params.push(processed);
    }
    
    query += ' ORDER BY timestamp LIMIT ?';
    params.push(limit);
    
    var stmt = this.db.prepare(query);
    if (params.length > 0) {
        stmt = stmt.bind.apply(stmt, params);
    }
    return stmt.all().then(function(response) {
        var results = response.results || [];
        return results.map(function(row) {
            return {
                id: row.id,
                type: row.type,
                timestamp: row.timestamp,
                data: JSON.parse(row.data),
                processed: row.processed
            };
        });
    });
};

// ==================== 工具方法 ====================

/**
 * 从metadata中提取字段用于索引
 */
D1Database.prototype.extractMetadataFields = function(metadata) {
    return {
        fileName: metadata.FileName || null,
        fileType: metadata.FileType || null,
        fileSize: metadata.FileSize || null,
        uploadIP: metadata.UploadIP || null,
        uploadAddress: metadata.UploadAddress || null,
        listType: metadata.ListType || null,
        timestamp: metadata.TimeStamp || null,
        label: metadata.Label || null,
        directory: metadata.Directory || null,
        channel: metadata.Channel || null,
        channelName: metadata.ChannelName || null,
        tgFileId: metadata.TgFileId || null,
        tgChatId: null,
        tgBotToken: null,
        isChunked: metadata.IsChunked || false
    };
};

// ==================== 通用方法 ====================

/**
 * 通用的put方法，根据key类型自动选择存储位置
 */
D1Database.prototype.put = function(key, value, options) {
    options = options || {};

    if (key.startsWith('manage@index@operation_')) {
        var operationId = key.replace('manage@index@operation_', '');
        var operation = JSON.parse(value);
        return this.putIndexOperation(operationId, operation);
    } else if (key.startsWith('manage@')) {
        // 所有 manage@ 前缀的键统一存入 settings 表
        var category = key.split('@')[1] || '';
        return this.putSetting(key, value, category);
    } else {
        return this.putFile(key, value, options);
    }
};

/**
 * 通用的get方法，根据key类型自动选择获取位置
 */
D1Database.prototype.get = function(key) {
    var self = this;

    if (key.startsWith('manage@index@operation_')) {
        var operationId = key.replace('manage@index@operation_', '');
        return this.getIndexOperation(operationId).then(function(operation) {
            return operation ? JSON.stringify(operation) : null;
        });
    } else if (key.startsWith('manage@')) {
        return this.getSetting(key);
    } else {
        return this.getFile(key).then(function(file) {
            return file ? file.value : null;
        });
    }
};

/**
 * 通用的getWithMetadata方法
 */
D1Database.prototype.getWithMetadata = function(key) {
    var self = this;

    if (key.startsWith('manage@')) {
        return this.getSetting(key).then(function(value) {
            return value ? { value: value, metadata: {} } : null;
        });
    } else {
        return this.getFileWithMetadata(key);
    }
};

/**
 * 通用的delete方法
 */
D1Database.prototype.delete = function(key) {
    if (key.startsWith('manage@index@operation_')) {
        var operationId = key.replace('manage@index@operation_', '');
        return this.deleteIndexOperation(operationId);
    } else if (key.startsWith('manage@')) {
        return this.deleteSetting(key);
    } else {
        return this.deleteFile(key);
    }
};

/**
 * 通用的list方法
 */
D1Database.prototype.list = function(options) {
    options = options || {};
    var prefix = options.prefix || '';
    var self = this;

    if (prefix.startsWith('manage@index@operation_')) {
        return this.listIndexOperations(options).then(function(operations) {
            var keys = operations.map(function(op) {
                return {
                    name: 'manage@index@operation_' + op.id
                };
            });
            return { keys: keys };
        });
    } else if (prefix.startsWith('manage@')) {
        return this.listSettings(options);
    } else {
        return this.listFiles(options);
    }
};

var LISTING_COUNT_TTL_MS = 20 * 1000;
var CATALOG_PROBE_MORE_TTL_MS = 10 * 60 * 1000;
var CATALOG_PROBE_FRESH_TTL_MS = 20 * 1000;
var MAX_CHILD_DIRECTORIES = 500;
var METADATA_ID_BATCH = 80;
var listingCountCache = new WeakMap();
var catalogProbeCache = new WeakMap();

function cacheBucket(map, db) {
    var bucket = map.get(db);
    if (!bucket) {
        bucket = new Map();
        map.set(db, bucket);
    }
    return bucket;
}

function isDatabaseOverload(error) {
    var message = String(error && error.message || error || '');
    return /overloaded|too many resources/i.test(message);
}

// 目录前缀的开区间上界。'GalleryEpic/' -> 'GalleryEpic0'，'album/' -> 'album0'。
// 'albumish/' 不会落进 album/ 的范围，'100X_done/' 也不会落进 '100%_done/'。
function prefixUpperBound(prefix) {
    var chars = Array.from(String(prefix));
    for (var i = chars.length - 1; i >= 0; i--) {
        var codePoint = chars[i].codePointAt(0);
        if (codePoint < 0x10FFFF) {
            chars[i] = String.fromCodePoint(codePoint + 1);
            return chars.slice(0, i + 1).join('');
        }
    }
    return String(prefix) + '\uffff';
}

function normalizeListingDirectory(directory) {
    directory = String(directory || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (directory && !directory.endsWith('/')) {
        directory += '/';
    }
    return directory;
}

function listingFilter(extraSql, extraParams, search) {
    var sql = "timestamp IS NOT NULL AND id NOT GLOB 'chunk_*' AND (" + extraSql + ')';
    var params = extraParams.slice();
    if (search) {
        sql += " AND (instr(lower(id), ?) > 0 OR instr(lower(ifnull(file_name, '')), ?) > 0)";
        var needle = String(search).toLowerCase();
        params.push(needle, needle);
    }
    return { sql: sql, params: params };
}

function buildChildDirectoryQuery(directory, search) {
    if (search) {
        return buildChildDirectoryScan(directory, search);
    }
    return buildChildDirectorySkipScan(directory || '');
}

// 搜索要知道子目录里有没有命中，只能看文件名。浏览路径用下面的跳查。
function buildChildDirectoryScan(directory, search) {
    var selectParams = [];
    var childExpr;
    var where = ["timestamp IS NOT NULL", "id NOT GLOB 'chunk_*'"];
    var whereParams = [];

    if (directory) {
        childExpr = "substr(directory, 1, ? + instr(substr(directory, ?), '/') - 1)";
        selectParams.push(directory.length, directory.length + 1);
        where.push("directory >= ? AND directory < ?");
        whereParams.push(directory, prefixUpperBound(directory));
        where.push("instr(substr(directory, ?), '/') > 0");
        whereParams.push(directory.length + 1);
    } else {
        childExpr = "substr(directory, 1, instr(directory, '/') - 1)";
        where.push("directory IS NOT NULL AND instr(directory, '/') > 0");
    }

    where.push("(instr(lower(id), ?) > 0 OR instr(lower(ifnull(file_name, '')), ?) > 0)");
    var needle = String(search).toLowerCase();
    whereParams.push(needle, needle);

    return {
        sql: 'SELECT DISTINCT ' + childExpr + ' AS child FROM files WHERE ' + where.join(' AND ') + ' ORDER BY child',
        params: selectParams.concat(whereParams)
    };
}

// 按 directory 索引跳到下一个直接子目录，不读取该目录下的每一个文件。
// 子目录名不带结尾斜杠，和原来的索引列表一致。递归层数封顶，避免表达式写错时死循环。
function buildChildDirectorySkipScan(prefix) {
    var params = [];
    var placeholder = function(value) {
        params.push(value);
        return '?';
    };
    var upper = prefix ? prefixUpperBound(prefix) : '';
    var childSlash = function() {
        return 'substr(walk.dir, 1, length(' + placeholder(prefix) + ') + instr(substr(walk.dir, length(' + placeholder(prefix) + ') + 1), \'/\'))';
    };
    var successor = function() {
        var full = childSlash();
        var lengthOf = childSlash();
        var lastChar = childSlash();
        return 'substr(' + full + ', 1, length(' + lengthOf + ') - 1) || char(unicode(substr(' + lastChar + ', -1, 1)) + 1)';
    };

    var sql = 'WITH RECURSIVE walk(dir, n) AS (' +
        'SELECT directory, 1 FROM (' +
        'SELECT directory FROM files WHERE timestamp IS NOT NULL AND id NOT GLOB \'chunk_*\' ' +
        'AND directory > ' + placeholder(prefix) + ' ' +
        'AND (' + placeholder(upper) + ' = \'\' OR directory < ' + placeholder(upper) + ') ' +
        'AND instr(substr(directory, length(' + placeholder(prefix) + ') + 1), \'/\') > 0 ' +
        'ORDER BY directory LIMIT 1) ' +
        'UNION ALL SELECT (' +
        'SELECT f.directory FROM files f WHERE f.timestamp IS NOT NULL AND f.id NOT GLOB \'chunk_*\' ' +
        'AND f.directory >= (' + successor() + ') ' +
        'AND (' + placeholder(upper) + ' = \'\' OR f.directory < ' + placeholder(upper) + ') ' +
        'AND instr(substr(f.directory, length(' + placeholder(prefix) + ') + 1), \'/\') > 0 ' +
        'ORDER BY f.directory LIMIT 1), walk.n + 1 FROM walk ' +
        'WHERE walk.dir IS NOT NULL AND walk.n < ' + MAX_CHILD_DIRECTORIES +
        ') SELECT substr(dir, 1, length(' + placeholder(prefix) + ') + instr(substr(dir, length(' + placeholder(prefix) + ') + 1), \'/\') - 1) AS child FROM walk WHERE dir IS NOT NULL';
    return { sql: sql, params: params };
}

function buildDirectoryFileQuery(directory, search, recursive, unlimited, limit, start) {
    var filter;
    var sql;

    if (!recursive && directory) {
        filter = listingFilter('directory = ?', [directory], search);
        sql = 'SELECT id, metadata FROM files WHERE ' + filter.sql + ' ORDER BY timestamp DESC, id ASC';
    } else if (directory) {
        // 递归列出整个前缀。排序键不是索引前缀，大目录仍可能临时排序；管理端网格默认不走这里。
        filter = listingFilter('directory >= ? AND directory < ?', [directory, prefixUpperBound(directory)], search);
        sql = 'SELECT id, metadata FROM files WHERE ' + filter.sql + ' ORDER BY timestamp DESC, id ASC';
    } else {
        filter = listingFilter('1 = 1', [], search);
        sql = 'SELECT id, metadata FROM files WHERE ' + filter.sql + ' ORDER BY timestamp DESC, id ASC';
    }

    var params = filter.params.slice();
    if (!unlimited) {
        sql += ' LIMIT ? OFFSET ?';
        params.push(limit, start);
    }
    return { sql: sql, params: params };
}

async function listDirectoryFiles(db, directory, search, recursive, unlimited, limit, start) {
    if (!recursive && !directory) {
        return listRootFiles(db, search, unlimited, limit, start);
    }
    var query = buildDirectoryFileQuery(directory, search, recursive, unlimited, limit, start);
    var result = await runStatement(db, query);
    return (result.results || []).map(function(row) {
        return { id: row.id, metadata: parseMetadata(row.metadata) };
    });
}

// 根目录是 directory IS NULL 加上历史上的空字符串。OR 不能用目录索引，所以分成两段再合并。
// 每一段只取前 start+limit 行：全局前 K 名一定来自各段自己的前 K 名。
async function listRootFiles(db, search, unlimited, limit, start) {
    var window = unlimited ? null : start + limit;
    var branches = [
        listingFilter('directory IS NULL', [], search),
        listingFilter("directory = ''", [], search)
    ];
    var parts = await Promise.all(branches.map(function(filter) {
        var sql = 'SELECT id, timestamp FROM files WHERE ' + filter.sql + ' ORDER BY timestamp DESC, id ASC';
        var params = filter.params.slice();
        if (window != null) {
            sql += ' LIMIT ?';
            params.push(window);
        }
        return runStatement(db, { sql: sql, params: params });
    }));
    var merged = [];
    parts.forEach(function(part) {
        (part.results || []).forEach(function(row) { merged.push(row); });
    });
    merged.sort(function(a, b) {
        var delta = (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
        if (delta !== 0) return delta;
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
    });
    var page = unlimited ? merged : merged.slice(start, start + limit);
    return loadFilesByIds(db, page.map(function(row) { return row.id; }));
}

async function loadFilesByIds(db, ids) {
    if (!ids.length) return [];
    var rows = [];
    for (var i = 0; i < ids.length; i += METADATA_ID_BATCH) {
        var slice = ids.slice(i, i + METADATA_ID_BATCH);
        var marks = slice.map(function() { return '?'; }).join(',');
        var result = await runStatement(db, {
            sql: 'SELECT id, metadata FROM files WHERE id IN (' + marks + ')',
            params: slice
        });
        rows = rows.concat(result.results || []);
    }
    var byId = new Map();
    rows.forEach(function(row) { byId.set(row.id, row); });
    return ids.filter(function(id) { return byId.has(id); }).map(function(id) {
        var row = byId.get(id);
        return { id: row.id, metadata: parseMetadata(row.metadata) };
    });
}

async function listChildDirectories(db, directory, search) {
    var result = await runStatement(db, buildChildDirectoryQuery(directory, search));
    var seen = new Set();
    var names = [];
    (result.results || []).forEach(function(row) {
        if (!row.child || seen.has(row.child)) return;
        seen.add(row.child);
        names.push(row.child);
    });
    names.sort();
    return names;
}

async function readListingCounts(db, directory, search) {
    var cacheKey = directory + '\0' + (search || '');
    var bucket = cacheBucket(listingCountCache, db);
    var cached = bucket.get(cacheKey);
    if (cached && Date.now() <= cached.expires) {
        return { totalCount: cached.totalCount, directFileCount: cached.directFileCount };
    }
    var counts = await computeListingCounts(db, directory, search);
    if (!counts.countsUnavailable) {
        bucket.set(cacheKey, {
            totalCount: counts.totalCount,
            directFileCount: counts.directFileCount,
            expires: Date.now() + LISTING_COUNT_TTL_MS
        });
    }
    return counts;
}

async function computeListingCounts(db, directory, search) {
    if (!directory && !search) {
        var directRow = await firstRow(db, {
            sql: "SELECT " +
                "(SELECT COUNT(*) FROM files WHERE directory IS NULL AND timestamp IS NOT NULL AND id NOT GLOB 'chunk_*') + " +
                "(SELECT COUNT(*) FROM files WHERE directory = '' AND timestamp IS NOT NULL AND id NOT GLOB 'chunk_*') AS directFileCount",
            params: []
        });
        var directFileCount = Number(directRow && directRow.directFileCount) || 0;
        try {
            var totalRow = await firstRow(db, {
                sql: "SELECT COUNT(*) AS totalCount FROM files WHERE timestamp IS NOT NULL AND id NOT GLOB 'chunk_*'",
                params: []
            });
            return {
                totalCount: Number(totalRow && totalRow.totalCount) || 0,
                directFileCount: directFileCount
            };
        } catch (error) {
            if (!isDatabaseOverload(error)) throw error;
            return {
                totalCount: directFileCount,
                directFileCount: directFileCount,
                countsUnavailable: true
            };
        }
    }

    if (!directory) {
        var scope = listingFilter('1 = 1', [], search);
        var directScope = listingFilter("(directory IS NULL OR directory = '')", [], search);
        var searched = await firstRow(db, {
            sql: 'SELECT COUNT(*) AS totalCount FROM files WHERE ' + scope.sql,
            params: scope.params
        });
        var searchedDirect = await firstRow(db, {
            sql: 'SELECT COUNT(*) AS directFileCount FROM files WHERE ' + directScope.sql,
            params: directScope.params
        });
        return {
            totalCount: Number(searched && searched.totalCount) || 0,
            directFileCount: Number(searchedDirect && searchedDirect.directFileCount) || 0
        };
    }

    var upper = prefixUpperBound(directory);
    if (!search) {
        var ranged = await firstRow(db, {
            sql: "SELECT COUNT(*) AS totalCount, COALESCE(SUM(CASE WHEN directory = ? THEN 1 ELSE 0 END), 0) AS directFileCount " +
                "FROM files WHERE timestamp IS NOT NULL AND id NOT GLOB 'chunk_*' AND directory >= ? AND directory < ?",
            params: [directory, directory, upper]
        });
        return {
            totalCount: Number(ranged && ranged.totalCount) || 0,
            directFileCount: Number(ranged && ranged.directFileCount) || 0
        };
    }

    var filtered = listingFilter('directory >= ? AND directory < ?', [directory, upper], search);
    var filteredRow = await firstRow(db, {
        sql: 'SELECT COUNT(*) AS totalCount, COALESCE(SUM(CASE WHEN directory = ? THEN 1 ELSE 0 END), 0) AS directFileCount FROM files WHERE ' + filtered.sql,
        params: [directory].concat(filtered.params)
    });
    return {
        totalCount: Number(filteredRow && filteredRow.totalCount) || 0,
        directFileCount: Number(filteredRow && filteredRow.directFileCount) || 0
    };
}

function lowerBoundCounts(files, start, limit, unlimited) {
    var pageFull = !unlimited && limit > 0 && files.length >= limit;
    var directFileCount = start + files.length + (pageFull ? 1 : 0);
    return {
        totalCount: directFileCount,
        directFileCount: directFileCount,
        countsUnavailable: true
    };
}

function runStatement(db, query) {
    var stmt = db.prepare(query.sql);
    if (query.params.length > 0) {
        stmt = stmt.bind.apply(stmt, query.params);
    }
    return stmt.all();
}

function firstRow(db, query) {
    var stmt = db.prepare(query.sql);
    if (query.params.length > 0) {
        stmt = stmt.bind.apply(stmt, query.params);
    }
    return stmt.first();
}

function parseMetadata(value) {
    try {
        return JSON.parse(value || '{}');
    } catch (error) {
        return {};
    }
}

// 导出构造函数
export { D1Database };
