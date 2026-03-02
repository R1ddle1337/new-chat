import type { ReactNode } from 'react';

type MainHeaderProps = {
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
};

export default function MainHeader({ title, subtitle, right }: MainHeaderProps) {
  return (
    <header className="main-header">
      <div className="main-header-text">
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {right ? <div className="main-header-right">{right}</div> : null}
    </header>
  );
}
