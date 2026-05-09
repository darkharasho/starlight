interface Props {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}

export function PageHeader({ title, subtitle, right }: Props): JSX.Element {
  return (
    <div className="flex items-baseline justify-between mb-4">
      <div>
        <h2 className="text-base font-semibold m-0">{title}</h2>
        {subtitle && <p className="text-xs text-muted m-0 mt-0.5">{subtitle}</p>}
      </div>
      {right && <div>{right}</div>}
    </div>
  );
}
