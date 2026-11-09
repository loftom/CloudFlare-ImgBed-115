export type Order = 'asc' | 'desc';

export interface DirEntry {
  path: string;
  name: string;
}

export interface FileEntry {
  path: string;
  name: string;
  kind: 'image' | 'video' | 'other';
  ts: number;
  size: number | null;
  blocked: boolean;
}

export interface ListResponse {
  dir: string;
  directories: DirEntry[];
  files: FileEntry[];
  start: number;
  count: number;
  order: Order;
  orderFallback?: boolean;
  directFileCount: number;
  totalCount: number;
  hasMore: boolean;
  countsUnavailable?: boolean;
}

export interface CoverResponse {
  dir: string;
  cover: FileEntry | null;
  directFileCount: number;
  childCount: number;
}

export interface GalleryConfig {
  imageBase: string;
  imageProxy: boolean;
  allowedDirs: string[];
  title: string;
}
