import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { useT } from '../../store/lang';
import { useSession } from '../../store/session';
import { EnrolForm } from './EnrolForm';

/**
 * Shown instead of the till when the server does not know which till this computer is (the shop has several tills and this one has
 * not been set up, or its setup was withdrawn). Nothing can be sold from here until an admin enrols it.
 */
export function DeviceNotATill() {
  const t = useT();
  const isAdmin = useSession((s) => s.user?.role) === 'admin';
  return (
    <main className="page" data-testid="device-not-a-till">
      <h1>
        <Icon name="till" size={26} />
        {t('This computer is not set up as a till')}
      </h1>
      <p>
        {t(
          'The shop has more than one till, and this computer has not been told which one it is. Selling is switched off here until it is.',
        )}
      </p>
      {isAdmin ? (
        <div className="banner warn" style={{ maxWidth: 520 }}>
          <div className="title">{t('Set it up now')}</div>
          <p style={{ margin: 0 }}>
            {t('Open Settings → Tills on a computer that is already working, add or choose this till, and type its code here.')}
          </p>
          <EnrolForm />
          <Link to="/settings/terminals">{t('Go to the list of tills')}</Link>
        </div>
      ) : (
        <p className="muted">{t('Ask the admin to set it up (Settings → Tills), or sign in as the admin on this computer.')}</p>
      )}
    </main>
  );
}
