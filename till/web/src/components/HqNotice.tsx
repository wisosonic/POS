import { useSettings } from '../hooks/useTillData';
import { useT } from '../store/lang';

/** True while this branch is connected to HQ: the catalog is HQ's then (docs/12 §17), and the screens that edit it say so. */
export const useHqOwnsCatalog = (): boolean => useSettings().data?.hqOwnsCatalog === true;

/** The note that replaces the edit buttons of a catalog screen at a connected branch. `what` is already translated. */
export function HqNotice({ what }: { what: string }) {
  const t = useT();
  return (
    <div className="banner" data-testid="hq-owns-catalog">
      <div className="title">{t('Managed at HQ')}</div>
      <div>{t('This branch is connected to HQ. {what} are changed at HQ and arrive here by themselves.', { what })}</div>
    </div>
  );
}
