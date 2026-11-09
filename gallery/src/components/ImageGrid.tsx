import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { imageUrl } from '../lib/api';
import { QueuedImage } from './QueuedImage';
import type { FileEntry } from '../lib/types';

interface Props {
  images: FileEntry[];
  imageBase: string;
  onOpen: (index: number) => void;
}

/** 套图三列网格：缩略图即原图（未开 CF Images 缩放），靠并发队列 + 懒加载控制带宽 */
export function ImageGrid({ images, imageBase, onOpen }: Props) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:gap-3 max-w-[1280px]">
      {images.map((f, i) => (
        <GridTile key={f.path} file={f} index={i} imageBase={imageBase} onOpen={onOpen} />
      ))}
    </div>
  );
}

const GridTile = React.memo(function GridTile({
  file, index, imageBase, onOpen,
}: { file: FileEntry; index: number; imageBase: string; onOpen: (i: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(index)}
      className="group relative block w-full aspect-[2/3] rounded-xl sm:rounded-2xl overflow-hidden bg-[#0d1017] border border-white/[0.07] shadow-lg transition-all duration-300 motion-safe:hover:-translate-y-1 hover:border-white/25 hover:shadow-[0_16px_36px_rgba(0,0,0,0.6)]"
      aria-label={`查看第 ${index + 1} 张：${file.name}`}
    >
      <QueuedImage
        url={imageUrl(imageBase, file.path)}
        alt={file.name}
        className="absolute inset-0"
        imgClassName="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
      />
      <span className="absolute top-2 left-2 px-2 py-0.5 text-[10px] font-mono bg-black/60 text-zinc-300 rounded-md backdrop-blur-md border border-white/10 pointer-events-none">
        #{index + 1}
      </span>
      {file.blocked && (
        <span className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-amber-500/20 text-amber-200 rounded-md border border-amber-500/30" title="ImgBed 将此文件标为屏蔽/成人内容，/file 会返回拦截图">
          <ShieldAlert className="w-3 h-3" /> 受限
        </span>
      )}
    </button>
  );
});
