interface Props {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}

export function PageHeader({ title, subtitle, right }: Props): JSX.Element {
  return (
    <div className="flex items-baseline justify-between mb-5">
      <div>
        <h2 className="text-[24px] font-semibold tracking-tight m-0">{title}</h2>
        {subtitle && <p className="text-[13px] text-muted m-0 mt-1">{subtitle}</p>}
      </div>
      {right && <div>{right}</div>}
    </div>
  );
}
