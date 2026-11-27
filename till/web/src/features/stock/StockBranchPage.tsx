import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { useT } from '../../store/lang';
import { useSession } from '../../store/session';

/**
 * Shown instead of the till at a STOCK branch (a warehouse): it has no tills, so nothing is sold here and no register is opened (docs/15 §3).
 * The stock work of a warehouse (receiving, shipping) is built with the transfers (P5b); until then this says what the place is.
 */
export function StockBranchPage() {
  const t = useT();
  const isManager = useSession((s) => s.user?.role === 'manager' || s.user?.role === 'admin');
  return (
    <main className="page" data-testid="stock-branch">
      <h1>
        <Icon name="stock" size={26} />
        {t('This is a stock branch')}
      </h1>
      <p>{t('A stock branch is a warehouse: it has no tills, so nothing is sold here and no register is opened.')}</p>
      {isManager && (
        <div className="banner" style={{ maxWidth: 520 }}>
          <div className="title">{t('Stock work')}</div>
          <div className="buttons">
            <Link className="btn" to="/products">
              {t('Products')}
            </Link>
            <Link className="btn" to="/low-stock">
              {t('Low stock')}
            </Link>
            <Link className="btn" to="/stocktake">
              {t('Stocktake')}
            </Link>
          </div>
        </div>
      )}
    </main>
  );
}
