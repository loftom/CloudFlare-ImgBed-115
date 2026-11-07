import assert from 'node:assert/strict';
import { loadFunction, memoryDatabase } from './helpers/loadFunction.js';
import { createContext } from './helpers/context.js';
import { managementFixture } from './helpers/management.js';
import { sqliteDatabase } from './helpers/database.js';
import * as metadataSecurity from '../functions/utils/metadata/metadataSecurity.js';
import * as fileTools from '../functions/file/fileTools.js';
import * as imageTransform from '../functions/file/imageTransform.js';
import * as adaptive from '../functions/random/adaptive.js';
import * as fileExpiryHelpers from '../functions/utils/fileExpiryHelpers.js';

async function loadListRoute(db, usingD1) {
    const database = { getDatabase: () => db, checkDatabaseConfig: () => ({ usingD1, hasD1: usingD1 }) };
    const index = await loadFunction('functions/utils/indexManager.js', database);
    const view = await loadFunction('functions/utils/metadata/metadataView.js', {
        ...metadataSecurity,
        loadChannelConfig: async () => ({}),
        findConfiguredChannel: () => null,
    });
    const route = await loadFunction('functions/api/manage/list.js', {
        ...database, ...index, ...view, maybeCleanupExpiredFiles: () => {},
    });
    return { route, index };
}

async function captureListingPlans(sqlite, db) {
    const queries = [];
    const originalPrepare = sqlite.prepare.bind(sqlite);
    sqlite.prepare = sql => {
        const statement = originalPrepare(sql);
        const originalBind = statement.bind.bind(statement);
        statement.bind = (...params) => {
            queries.push({ sql, params });
            return originalBind(...params);
        };
        return statement;
    };
    try {
        await db.queryDirectoryListing({ directory: '', start: 0, count: 2 });
        await db.queryDirectoryListing({ directory: 'album/', start: 0, count: 1 });
    } finally {
        sqlite.prepare = originalPrepare;
    }
    const explain = ({ sql, params }) => sqlite.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(row => row.detail);
    return {
        root: explain(queries.find(query => query.sql.startsWith('SELECT id, timestamp') && query.sql.includes('directory IS NULL'))),
        album: explain(queries.find(query => query.sql.startsWith('SELECT id, metadata FROM files') && query.params[0] === 'album/')),
    };
}

describe('read and list files', () => {
    let db, mocks;

    beforeEach(() => {
        db = memoryDatabase();
        mocks = { getDatabase: () => db, checkDatabaseConfig: () => ({ usingD1: false }), ...fileExpiryHelpers };
    });

    function context(url) { return createContext(url); }

    it('preserves strict list filtering, OR selection, and generic historical metadata', async () => {
        const index = await loadFunction('functions/utils/indexManager.js', mocks);
        const files = [
            { id: 'a.png', metadata: { FileType: 'image/png' } },
            { id: 'b.mp4', metadata: { FileType: 'video/mp4' } },
            { id: 'c.bin', metadata: { FileType: 'application/x-image' } },
            { id: 'old.png', metadata: { FileType: 'application/octet-stream' } },
        ];
        await db.put('manage@index@meta', JSON.stringify({ chunkCount: 1, totalCount: files.length }));
        await db.put('manage@index_0', JSON.stringify(files));
        const ctx = context('https://test/api/manage/list');
        const images = await index.readIndex(ctx, { count: -1, fileType: ['image'] });
        assert.equal(images.success, true);
        assert.deepEqual(images.files.map(file => file.id), ['a.png']);
        const mixed = await index.readIndex(ctx, { count: -1, fileType: ['image', 'video'] });
        assert.deepEqual(mixed.files.map(file => file.id), ['a.png', 'b.mp4']);
        const other = await index.readIndex(ctx, { count: -1, fileType: ['other'] });
        assert.deepEqual(other.files.map(file => file.id), ['c.bin', 'old.png']);
        assert.equal((await index.readIndex(ctx, { count: -1, fileType: ['bogus'] })).files.length, 0);
    });

    it('keeps directory pagination, recursion and totals consistent through the management API', async () => {
        const fixture = await managementFixture();
        await fixture.seed([
            ['album/a.png', 'album/'], ['album/b.png', 'album/'], ['album/sub/c.png', 'album/sub/'], ['albumish/d.png', 'albumish/'],
        ].map(([id, Directory]) => ({ id, metadata: { Channel: 'CloudflareR2', Directory, FileName: id, FileType: 'image/png' } })));
        const route = await loadFunction('functions/api/manage/list.js', fixture.mocks);
        const list = async query => {
            const response = await route.onRequest(createContext(`https://test/api/manage/list?${query}`, { env: fixture.env }));
            assert.equal(response.status, 200);
            return response.json();
        };
        const page = await list('dir=album&start=1&count=1');
        assert.equal(page.isIndexedResponse, true);
        assert.deepEqual(page.files.map(file => file.name), ['album/b.png']);
        assert.deepEqual(page.directories, ['album/sub']);
        assert.equal(page.totalCount, 3);
        assert.equal(page.directFileCount, 2);
        assert.equal(page.returnedCount, 1);
        const recursive = await list('dir=album&count=-1&recursive=true');
        assert.deepEqual(recursive.files.map(file => file.name), ['album/a.png', 'album/b.png', 'album/sub/c.png']);
        assert.equal((await list('dir=album&count=-1&sum=true')).sum, 3);
        assert.deepEqual((await list('dir=album&search=B.PNG')).files.map(file => file.name), ['album/b.png']);
    });

    it('does not rebuild or reread the index when a list can be served from it', async () => {
        const db = memoryDatabase();
        const reads = [];
        const originalGet = db.get.bind(db);
        db.get = async key => { reads.push(key); return originalGet(key); };
        const files = [{ id: 'a.png', metadata: { TimeStamp: 1, FileName: 'a.png' } }];
        await db.put('manage@index@meta', JSON.stringify({ chunkCount: 1, chunkSize: 500, totalCount: 1 }));
        await db.put('manage@index_0', JSON.stringify(files));
        const { index } = await loadListRoute(db, false);
        const ctx = context('https://test/api/manage/list');
        const page = await index.readIndex(ctx, { count: 10 });
        assert.equal(page.success, true);
        assert.deepEqual(page.files.map(file => file.id), ['a.png']);
        assert.equal(reads.filter(key => key === 'manage@index_0').length, 1);
        assert.equal(ctx.backgroundTasks.length, 0);
    });

    it('does not schedule a rebuild when the index is missing, incomplete, or too large to load', async () => {
        const indexModule = await loadFunction('functions/utils/indexManager.js', {
            getDatabase: () => memoryDatabase(),
            checkDatabaseConfig: () => ({ usingD1: true }),
        });
        assert.equal(indexModule.MAX_IN_MEMORY_INDEX_FILES >= 100000, true);

        for (const [label, seed] of [
            ['missing', async db => db],
            ['incomplete', async db => {
                await db.put('manage@index@meta', JSON.stringify({ chunkCount: 2, chunkSize: 500, totalCount: 1 }));
                await db.put('manage@index_0', JSON.stringify([{ id: 'only.png', metadata: { TimeStamp: 1 } }]));
            }],
            ['too large', async db => {
                await db.put('manage@index@meta', JSON.stringify({
                    chunkCount: Math.ceil(indexModule.MAX_IN_MEMORY_INDEX_FILES / 500) + 1,
                    chunkSize: 500,
                    totalCount: 1,
                }));
                await db.put('manage@index_0', JSON.stringify([{ id: 'hidden.png', metadata: { TimeStamp: 1 } }]));
            }],
        ]) {
            const db = memoryDatabase();
            const reads = [];
            const originalGet = db.get.bind(db);
            db.get = async key => { reads.push(key); return originalGet(key); };
            await seed(db);
            const { index } = await loadListRoute(db, true);
            const ctx = context('https://test/api/manage/list');
            const result = await index.readIndex(ctx, { count: 10 });
            assert.equal(result.success, false, label);
            assert.equal(ctx.backgroundTasks.length, 0, label);
            if (label === 'too large') {
                assert.deepEqual(reads, ['manage@index@meta']);
            }
            if (label === 'incomplete') {
                assert.equal(result.files.length, 0);
            }
        }
    });

    it('writes index chunks before publishing metadata', async () => {
        const db = memoryDatabase();
        await db.put('manage@index@meta', JSON.stringify({ chunkCount: 1, chunkSize: 500, totalCount: 1, lastUpdated: 1 }));
        await db.put('manage@index_0', JSON.stringify([{ id: 'a.png', metadata: { TimeStamp: 1, FileName: 'a.png' } }]));
        await db.put('manage@index@operation_1_add', JSON.stringify({
            type: 'add',
            timestamp: 2,
            data: { fileId: 'b.png', metadata: { TimeStamp: 2, FileName: 'b.png' } },
        }));
        const writes = [];
        const originalPut = db.put.bind(db);
        db.put = async (key, value, options) => {
            writes.push(key);
            return originalPut(key, value, options);
        };
        const { index } = await loadListRoute(db, false);
        const merged = await index.mergeOperationsToIndex(context('https://test/api/manage/list'));
        assert.equal(merged.success, true, merged.error);
        const chunkAt = writes.indexOf('manage@index_0');
        const metaAt = writes.indexOf('manage@index@meta');
        assert.ok(chunkAt !== -1 && metaAt !== -1 && chunkAt < metaAt);
    });

    it('pages an unavailable index from D1 without scanning or rebuilding', async () => {
        const { sqlite, db } = await sqliteDatabase();
        const files = [
            ['a.png', '', 300],
            ['b.png', '', 200],
            ['c.png', '', 100],
            ['album/a.png', 'album/', 250],
            ['album/b.png', 'album/', 150],
            ['album/sub/c.png', 'album/sub/', 50],
            ['album/sub/deep/e.png', 'album/sub/deep/', 40],
            ['albumish/d.png', 'albumish/', 400],
            ['100%_done/p.png', '100%_done/', 10],
            ['100X_done/q.png', '100X_done/', 9],
            ['chunk_upload_000', '', 999],
            ['note.txt', '', null],
        ];
        for (const [id, Directory, TimeStamp] of files) {
            const metadata = { FileName: id.split('/').pop(), Directory, Channel: 'CloudflareR2', FileType: 'image/png' };
            if (TimeStamp != null) metadata.TimeStamp = TimeStamp;
            await db.put(id, '', { metadata });
        }
        const rootDir = sqlite.db.prepare('SELECT directory FROM files WHERE id = ?').get('a.png');
        assert.equal(rootDir.directory, null);
        sqlite.db.prepare(
            "INSERT INTO files (id, value, metadata, timestamp, directory, file_name) VALUES ('legacy.png', '', ?, 350, '', 'legacy.png')"
        ).run(JSON.stringify({ TimeStamp: 350, FileName: 'legacy.png', Directory: '', FileType: 'image/png' }));

        const { route } = await loadListRoute(db, true);
        const list = async query => {
            const ctx = createContext(`https://test/api/manage/list?${query}`);
            const response = await route.onRequest(ctx);
            assert.equal(response.status, 200, query);
            assert.equal(ctx.backgroundTasks.length, 0, query);
            return response.json();
        };

        const root = await list('count=2&start=0');
        assert.equal(root.isIndexedResponse, false);
        assert.deepEqual(root.files.map(file => file.name), ['legacy.png', 'a.png']);
        assert.deepEqual(root.directories, ['100%_done', '100X_done', 'album', 'albumish']);
        assert.equal(root.totalCount, 11);
        assert.equal(root.directFileCount, 4);
        assert.equal(root.directFolderCount, 4);
        assert.equal(root.returnedCount, 2);
        assert.deepEqual((await list('count=2&start=2')).files.map(file => file.name), ['b.png', 'c.png']);

        const album = await list('dir=album&start=1&count=1');
        assert.deepEqual(album.files.map(file => file.name), ['album/b.png']);
        assert.deepEqual(album.directories, ['album/sub']);
        assert.equal(album.totalCount, 4);
        assert.equal(album.directFileCount, 2);
        assert.equal(album.returnedCount, 1);
        assert.deepEqual((await list('dir=album&count=-1')).files.map(file => file.name), ['album/a.png', 'album/b.png']);
        const recursive = await list('dir=album&count=-1&recursive=true');
        assert.deepEqual(recursive.files.map(file => file.name), ['album/a.png', 'album/b.png', 'album/sub/c.png', 'album/sub/deep/e.png']);
        assert.equal((await list('dir=album&count=-1&sum=true')).sum, 4);
        assert.deepEqual((await list('dir=album&search=B.PNG')).files.map(file => file.name), ['album/b.png']);
        assert.deepEqual((await list('dir=100%_done&count=10')).files.map(file => file.name), ['100%_done/p.png']);

        const meta = sqlite.db.prepare('SELECT value FROM settings WHERE key = ?').get('manage@index@meta');
        assert.equal(meta, undefined);

        const plans = await captureListingPlans(sqlite, db);
        for (const [name, details] of [['album', plans.album], ['root', plans.root]]) {
            assert.ok(details.some(detail => detail.includes('idx_files_directory_timestamp')), name + '\n' + details.join('\n'));
            assert.ok(!details.some(detail => detail.includes('USE TEMP B-TREE')), name + '\n' + details.join('\n'));
            assert.ok(!details.some(detail => detail.includes('SCAN files')), name + '\n' + details.join('\n'));
        }
    });

    it('keeps a complete D1 index for filters and ignores a stale index that cannot cover the catalog', async () => {
        const covered = await sqliteDatabase();
        await covered.db.put('kept.png', '', {
            metadata: { TimeStamp: 2, FileName: 'kept.png', Directory: '', Channel: 'CloudflareR2', FileType: 'image/png' },
        });
        await covered.db.put('other.png', '', {
            metadata: { TimeStamp: 1, FileName: 'other.png', Directory: '', Channel: 'S3', FileType: 'image/png' },
        });
        const indexed = [
            { id: 'kept.png', metadata: { TimeStamp: 2, FileName: 'kept.png', Directory: '', Channel: 'CloudflareR2', FileType: 'image/png' } },
            { id: 'other.png', metadata: { TimeStamp: 1, FileName: 'other.png', Directory: '', Channel: 'S3', FileType: 'image/png' } },
        ];
        await covered.db.put('manage@index@meta', JSON.stringify({ chunkCount: 1, chunkSize: 500, totalCount: indexed.length }));
        await covered.db.put('manage@index_0', JSON.stringify(indexed));
        const coveredRoute = await loadListRoute(covered.db, true);
        const coveredPage = await (await coveredRoute.route.onRequest(createContext('https://test/api/manage/list?count=10&channel=CloudflareR2'))).json();
        assert.equal(coveredPage.isIndexedResponse, true);
        assert.deepEqual(coveredPage.files.map(file => file.name), ['kept.png']);

        const stale = await sqliteDatabase();
        await stale.db.put('a.png', '', { metadata: { TimeStamp: 2, FileName: 'a.png', Directory: '', FileType: 'image/png' } });
        await stale.db.put('b.png', '', { metadata: { TimeStamp: 1, FileName: 'b.png', Directory: '', FileType: 'image/png' } });
        await stale.db.put('manage@index@meta', JSON.stringify({ chunkCount: 1, chunkSize: 500, totalCount: 1, lastUpdated: 1 }));
        await stale.db.put('manage@index_0', JSON.stringify([
            { id: 'a.png', metadata: { TimeStamp: 2, FileName: 'a.png', Directory: '' } },
        ]));
        const reads = [];
        const writes = [];
        const originalGet = stale.db.get.bind(stale.db);
        const originalPut = stale.db.put.bind(stale.db);
        stale.db.get = async key => { reads.push(key); return originalGet(key); };
        stale.db.put = async (key, value, options) => { writes.push(key); return originalPut(key, value, options); };
        const { route } = await loadListRoute(stale.db, true);
        const ctx = createContext('https://test/api/manage/list?count=10');
        const body = await (await route.onRequest(ctx)).json();
        assert.equal(body.isIndexedResponse, false);
        assert.deepEqual(body.files.map(file => file.name).sort(), ['a.png', 'b.png']);
        assert.equal(body.totalCount, 2);
        assert.equal(reads.includes('manage@index_0'), false);
        assert.equal(writes.includes('manage@index_0'), false);
        assert.equal(ctx.backgroundTasks.length, 0);
    });

    it('pages a large directory from the composite index and lists only immediate children', async () => {
        const { sqlite, db } = await sqliteDatabase();
        const insert = sqlite.db.prepare(
            'INSERT INTO files (id, value, metadata, timestamp, directory, file_name, file_type) VALUES (?, \'\', ?, ?, ?, ?, \'image/png\')'
        );
        sqlite.db.transaction(() => {
            for (let i = 0; i < 800; i++) {
                const name = String(i).padStart(4, '0') + '.png';
                insert.run(
                    'big/' + name,
                    JSON.stringify({ TimeStamp: i, FileName: name, Directory: 'big/', FileType: 'image/png' }),
                    i,
                    'big/',
                    name
                );
            }
            insert.run('big/sub/a.png', JSON.stringify({ TimeStamp: 5000, FileName: 'a.png', Directory: 'big/sub/', FileType: 'image/png' }), 5000, 'big/sub/', 'a.png');
            insert.run('big/sub/deep/z.png', JSON.stringify({ TimeStamp: 6000, FileName: 'z.png', Directory: 'big/sub/deep/', FileType: 'image/png' }), 6000, 'big/sub/deep/', 'z.png');
            insert.run('big/other/b.png', JSON.stringify({ TimeStamp: 1, FileName: 'b.png', Directory: 'big/other/', FileType: 'image/png' }), 1, 'big/other/', 'b.png');
            insert.run('bigish/nope.png', JSON.stringify({ TimeStamp: 9000, FileName: 'nope.png', Directory: 'bigish/', FileType: 'image/png' }), 9000, 'bigish/', 'nope.png');
        })();

        const queries = [];
        const originalPrepare = sqlite.prepare.bind(sqlite);
        sqlite.prepare = sql => {
            const statement = originalPrepare(sql);
            const originalBind = statement.bind.bind(statement);
            statement.bind = (...params) => {
                queries.push({ sql, params });
                return originalBind(...params);
            };
            return statement;
        };
        const { route } = await loadListRoute(db, true);
        const list = async query => {
            const response = await route.onRequest(createContext(`https://test/api/manage/list?${query}`));
            assert.equal(response.status, 200, query);
            return response.json();
        };
        const page = await list('dir=big&count=2&start=0');
        assert.equal(page.isIndexedResponse, false);
        assert.deepEqual(page.files.map(file => file.name), ['big/0799.png', 'big/0798.png']);
        assert.deepEqual(page.directories, ['big/other', 'big/sub']);
        assert.equal(page.totalCount, 803);
        assert.equal(page.directFileCount, 800);
        assert.equal(page.directFolderCount, 2);
        const offset = await list('dir=big&count=1&start=100');
        assert.deepEqual(offset.files.map(file => file.name), ['big/0699.png']);

        const explain = ({ sql, params }) => sqlite.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(row => row.detail);
        const fileQuery = queries.find(query => query.sql.startsWith('SELECT id, metadata FROM files') && query.params[0] === 'big/');
        const childQuery = queries.find(query => query.sql.startsWith('WITH RECURSIVE') && query.params.includes('big/'));
        const filePlan = explain(fileQuery);
        const childPlan = explain(childQuery);
        assert.ok(filePlan.some(detail => detail.includes('idx_files_directory_timestamp')), filePlan.join('\n'));
        assert.ok(!filePlan.some(detail => detail.includes('USE TEMP B-TREE')), filePlan.join('\n'));
        assert.ok(childPlan.some(detail => detail.includes('idx_files_directory_timestamp')), childPlan.join('\n'));
        assert.ok(!childPlan.some(detail => detail.includes('SCAN files')), childPlan.join('\n'));
        sqlite.prepare = originalPrepare;
    });

    it('returns the current page when D1 refuses the count', async () => {
        const { sqlite, db } = await sqliteDatabase();
        await db.put('a.png', '', { metadata: { TimeStamp: 2, FileName: 'a.png', Directory: '', FileType: 'image/png' } });
        await db.put('album/a.png', '', { metadata: { TimeStamp: 2, FileName: 'a.png', Directory: 'album/', FileType: 'image/png' } });
        await db.put('album/b.png', '', { metadata: { TimeStamp: 1, FileName: 'b.png', Directory: 'album/', FileType: 'image/png' } });
        const originalPrepare = sqlite.prepare.bind(sqlite);
        sqlite.prepare = sql => {
            const statement = originalPrepare(sql);
            if (sql.includes('COUNT(*)')) {
                const fail = async () => {
                    throw new Error('D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window');
                };
                statement.first = fail;
                statement.all = fail;
            }
            return statement;
        };
        const { route } = await loadListRoute(db, true);
        const root = await (await route.onRequest(createContext('https://test/api/manage/list?count=10'))).json();
        assert.equal(root.countsUnavailable, true);
        assert.deepEqual(root.files.map(file => file.name), ['a.png']);
        assert.equal(root.directFileCount, 1);
        const album = await (await route.onRequest(createContext('https://test/api/manage/list?dir=album&count=1'))).json();
        assert.equal(album.countsUnavailable, true);
        assert.deepEqual(album.files.map(file => file.name), ['album/a.png']);
        assert.ok(album.directFileCount >= 2);
        sqlite.prepare = originalPrepare;

        const counted = await sqliteDatabase();
        for (const [id, time] of [['a.png', 3], ['b.png', 2], ['c.png', 1]]) {
            await counted.db.put(id, '', { metadata: { TimeStamp: time, FileName: id, Directory: '', FileType: 'image/png' } });
        }
        await counted.db.put('album/nested.png', '', {
            metadata: { TimeStamp: 4, FileName: 'nested.png', Directory: 'album/', FileType: 'image/png' },
        });
        const countedPrepare = counted.sqlite.prepare.bind(counted.sqlite);
        counted.sqlite.prepare = sql => {
            const statement = countedPrepare(sql);
            if (sql.startsWith("SELECT COUNT(*) AS totalCount FROM files WHERE timestamp IS NOT NULL")) {
                statement.first = async () => {
                    throw new Error('D1 DB is overloaded');
                };
            }
            return statement;
        };
        const countedRoute = await loadListRoute(counted.db, true);
        const partial = await (await countedRoute.route.onRequest(createContext('https://test/api/manage/list?count=1'))).json();
        assert.equal(partial.countsUnavailable, true);
        assert.deepEqual(partial.files.map(file => file.name), ['a.png']);
        assert.equal(partial.directFileCount, 3);
        assert.equal(partial.totalCount, 3);
        const sumResponse = await countedRoute.route.onRequest(createContext('https://test/api/manage/list?count=-1&sum=true'));
        assert.equal(sumResponse.status, 500);
    });

    it('creates the directory timestamp index from the operator migration', async () => {
        const { readFile } = await import('node:fs/promises');
        const { sqlite, db } = await sqliteDatabase();
        sqlite.exec('DROP INDEX IF EXISTS idx_files_directory_timestamp');
        assert.equal(
            sqlite.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_files_directory_timestamp'").get(),
            undefined
        );
        const migration = await readFile('database/migrations/idx_files_directory_timestamp.sql', 'utf8');
        sqlite.exec(migration);
        sqlite.exec(migration);
        const created = sqlite.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_files_directory_timestamp'").get();
        assert.match(created.sql, /directory, timestamp DESC, id/i);
        const kept = sqlite.db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_files_directory'").get();
        assert.equal(kept.name, 'idx_files_directory');
        await db.put('album/a.png', '', { metadata: { TimeStamp: 1, FileName: 'a.png', Directory: 'album/', FileType: 'image/png' } });
        const { route } = await loadListRoute(db, true);
        const page = await (await route.onRequest(createContext('https://test/api/manage/list?dir=album&count=10'))).json();
        assert.deepEqual(page.files.map(file => file.name), ['album/a.png']);
    });

    it('still accepts an explicit rebuild without starting one for an ordinary list', async () => {
        const { db } = await sqliteDatabase();
        await db.put('a.png', '', { metadata: { TimeStamp: 1, FileName: 'a.png', Directory: '', FileType: 'image/png' } });
        const { route } = await loadListRoute(db, true);
        const ordinary = createContext('https://test/api/manage/list?count=10');
        assert.equal((await (await route.onRequest(ordinary)).json()).isIndexedResponse, false);
        assert.equal(ordinary.backgroundTasks.length, 0);

        const rebuild = createContext('https://test/api/manage/list?action=rebuild');
        assert.equal(await (await route.onRequest(rebuild)).text(), 'Index rebuilt asynchronously');
        assert.ok(rebuild.backgroundTasks.length >= 1);
        await Promise.all(rebuild.backgroundTasks);
    });

    it('returns explicit errors for malformed IDs and missing records without reading storage', async () => {
        const route = await loadFunction('functions/file/[[path]].js', {
            ...mocks, ...fileTools, ...imageTransform,
            fetchSecurityConfig: async () => ({ access: { whiteListMode: false } }),
        });
        for (const [path, status] of [['%', 400], ['missing.png', 404]]) {
            const ctx = createContext('https://test/file/missing.png', {
                params: { path }, env: { img_r2: { get: () => assert.fail('should not read storage') } },
            });
            assert.equal((await route.onRequest(ctx)).status, status);
        }
    });

    it('keeps external files as redirects when no image transformation is requested', async () => {
        await db.put('external.png', '', { metadata: { Channel: 'External', ExternalLink: 'https://storage.invalid/photo.png' } });
        const route = await loadFunction('functions/file/[[path]].js', {
            ...mocks, ...fileTools, ...imageTransform,
            fetchSecurityConfig: async () => ({ access: { whiteListMode: false } }),
        });
        const response = await route.onRequest(createContext('https://test/file/external.png', { params: { path: 'external.png' } }));
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('Location'), 'https://storage.invalid/photo.png');
    });

    it('requires admin authentication for previews and keeps authorized previews private', async () => {
        await db.put('blocked.png', '', { metadata: { Channel: 'CloudflareR2', FileType: 'image/png', ListType: 'Block' } });
        for (const authorized of [false, true]) {
            let reads = 0;
            const route = await loadFunction('functions/file/[[path]].js', {
                ...mocks, ...fileTools, ...imageTransform,
                fetchSecurityConfig: async () => ({ access: { whiteListMode: false } }),
                AUTH_SCOPE: { ADMIN: 'admin' },
                authenticate: async options => {
                    assert.equal(options.authScope, 'admin');
                    assert.equal(options.requiredPermission, 'manage');
                    return { authorized, authType: authorized ? 'admin' : null };
                },
            });
            const ctx = createContext('https://test/file/blocked.png?from=admin', {
                params: { path: 'blocked.png' },
                env: { img_r2: { async get() {
                    reads++;
                    return { body: new Response('image').body, writeHttpMetadata() {} };
                } } },
            });
            const response = await route.onRequest(ctx);
            assert.equal(response.status, authorized ? 200 : 401);
            assert.equal(reads, authorized ? 1 : 0);
            assert.equal(response.headers.get('Cache-Control'), authorized ? fileTools.FILE_CACHE_CONTROL.PRIVATE : fileTools.FILE_CACHE_CONTROL.NO_STORE);
        }
    });

    it('keeps content= working through the random API for records without a known type', async () => {
        const previousCaches = globalThis.caches;
        const route = await loadFunction('functions/random/index.js', {
            ...adaptive,
            fetchOthersConfig: async () => ({ randomImageAPI: { enabled: true, allowedDir: '' } }),
        });
        try {
            globalThis.caches = { default: { match: async () => new Response(JSON.stringify([{ name: 'notes.unknown', FileType: '' }])) } };
            const response = await route.onRequest({ request: new Request('https://test/random?content='), env: {} });
            assert.deepEqual(await response.json(), { url: '/file/notes.unknown' });
            const filtered = await route.onRequest({ request: new Request('https://test/random'), env: {} });
            assert.deepEqual(await filtered.json(), {});
        } finally {
            if (previousCaches === undefined) delete globalThis.caches;
            else globalThis.caches = previousCaches;
        }
    });

    it('preserves GET/HEAD/Range response behavior and Content-Type parameters without historical inference', async () => {
        const route = await loadFunction('functions/file/[[path]].js', {
            ...mocks, ...fileTools, ...imageTransform,
            fetchSecurityConfig: async () => ({ access: { whiteListMode: false } }),
        });
        for (const [type, expected] of [[' Application/PDF ; name=Photo ', 'application/pdf; name=Photo'], ['application/octet-stream', 'application/octet-stream']]) {
            await db.put('photo.jpg', '', { metadata: { Channel: 'CloudflareR2', FileName: 'photo.jpg', FileType: type } });
            for (const [method, range] of [['GET', false], ['HEAD', false], ['GET', true]]) {
                const ctx = context('https://test/file/photo.jpg');
                ctx.env.img_r2 = {};
                ctx.request = new Request(ctx.url, { method, headers: range ? { Range: 'bytes=0-1' } : {} });
                ctx.params = { path: 'photo.jpg' };
                ctx.env.img_r2.get = async (id, options) => ({
                    body: new Response(range ? 'so' : 'source').body,
                    size: 6,
                    range: options?.range,
                    writeHttpMetadata(headers) { headers.set('Content-Type', 'application/octet-stream'); },
                });
                const response = await route.onRequest(ctx);
                assert.equal(response.status, range ? 206 : 200);
                assert.equal(response.headers.get('Content-Type'), expected);
                assert.equal(await response.text(), method === 'HEAD' ? '' : range ? 'so' : 'source');
                if (range) assert.equal(response.headers.get('Content-Range'), 'bytes 0-1/6');
            }
        }
    });
});
