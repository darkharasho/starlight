const SIZES = {
  sm: 'w-[60px] h-[90px] rounded-md text-[9px]',
  md: 'w-[76px] h-[114px] rounded-lg text-[10px]',
  lg: 'w-[104px] h-[156px] rounded-lg text-[11px]',
};

/** The game's box art, or its name on a plain tile until (or instead of) the art. */
export function GameCover({ title, cover, size }: {
  title: string; cover: { src: string | null; onError: () => void }; size: keyof typeof SIZES;
}): JSX.Element {
  return (
    <div className={`relative shrink-0 overflow-hidden bg-raised border border-white/10 shadow-[0_14px_40px_rgba(0,0,0,0.6)] transition-[width,height] duration-500 ease-out ${SIZES[size]}`}>
      <span className="absolute inset-0 flex items-center justify-center px-1.5 text-center text-muted leading-tight">{title}</span>
      {cover.src && <img src={cover.src} alt="" onError={cover.onError} className="absolute inset-0 size-full object-cover" />}
    </div>
  );
}
