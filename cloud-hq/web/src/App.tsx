import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { post } from './lib/api';
import { canPayroll, clearSession, getMe, isAdmin, setSession, type Me } from './lib/session';
import { AttendancePage } from './pages/AttendancePage';
import { BackupsPage } from './pages/BackupsPage';
import { BranchesPage } from './pages/BranchesPage';
import { ChoosePasswordPage } from './pages/ChoosePasswordPage';
import { LoginPage } from './pages/LoginPage';
import { MyPayPage } from './pages/MyPayPage';
import { OverviewPage } from './pages/OverviewPage';
import { PayrollPage } from './pages/PayrollPage';
import { PaySetupPage } from './pages/PaySetupPage';
import { PeoplePage } from './pages/PeoplePage';
import { PurchasingPage } from './pages/PurchasingPage';
import { RestockPage } from './pages/RestockPage';
import { SchedulePage } from './pages/SchedulePage';
import { StaffPage } from './pages/StaffPage';

export function App() {
  const [me, setMe] = useState<Me | null>(() => getMe());
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // HQ stopped accepting the sign-in (it expired, or the account changed): back to the sign-in page, with nothing of the last person left on screen.
  useEffect(() => {
    const out = () => {
      queryClient.clear();
      setMe(null);
      navigate('/login');
    };
    window.addEventListener('hq-signed-out', out);
    return () => window.removeEventListener('hq-signed-out', out);
  }, [queryClient, navigate]);

  const signedIn = (token: string, person: Me) => {
    setSession(token, person);
    setMe(person);
  };
  async function signOut() {
    try {
      await post('/auth/logout');
    } catch {
      /* already out */
    }
    clearSession();
    queryClient.clear();
    setMe(null);
    navigate('/login');
  }

  if (!me)
    return (
      <Routes>
        <Route path="/login" element={<LoginPage onSignedIn={signedIn} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  // An account that must choose its own password sees nothing else until it has (the server refuses everything else too).
  if (me.mustResetPassword) return <ChoosePasswordPage me={me} onDone={signedIn} onCancel={signOut} />;
  // An employee account sees only its own attendance and paid payslips.
  if (me.role === 'employee') return <MyPayPage name={me.name} onSignOut={() => void signOut()} />;

  return (
    <div className="shell">
      <nav className="side" aria-label="Main">
        <div className="brand">HQ</div>
        <NavLink to="/" end>
          Overview
        </NavLink>
        <NavLink to="/branches">Branches</NavLink>
        <NavLink to="/purchasing">Purchasing</NavLink>
        <NavLink to="/restock">Stock suggestions</NavLink>
        <NavLink to="/people">People</NavLink>
        <NavLink to="/attendance">Attendance</NavLink>
        <NavLink to="/schedule">Schedule</NavLink>
        {canPayroll(me) && <NavLink to="/payroll">Payroll</NavLink>}
        {canPayroll(me) && <NavLink to="/pay-setup">Pay setup</NavLink>}
        {isAdmin(me) && <NavLink to="/backups">Backups</NavLink>}
        {isAdmin(me) && <NavLink to="/staff">Staff</NavLink>}
        <div className="spacer" />
        <div className="who">
          {me.name}
          <span className="muted"> · {me.role}</span>
        </div>
        <button className="btn ghost" onClick={() => void signOut()}>
          Sign out
        </button>
      </nav>
      <main className="page">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/branches" element={<BranchesPage me={me} />} />
          <Route path="/purchasing" element={<PurchasingPage me={me} />} />
          <Route path="/restock" element={<RestockPage me={me} />} />
          <Route path="/people" element={<PeoplePage me={me} />} />
          <Route path="/attendance" element={<AttendancePage me={me} />} />
          <Route path="/schedule" element={<SchedulePage me={me} />} />
          <Route path="/payroll" element={canPayroll(me) ? <PayrollPage /> : <Navigate to="/" replace />} />
          <Route path="/pay-setup" element={canPayroll(me) ? <PaySetupPage /> : <Navigate to="/" replace />} />
          <Route path="/backups" element={isAdmin(me) ? <BackupsPage /> : <Navigate to="/" replace />} />
          <Route path="/staff" element={isAdmin(me) ? <StaffPage me={me} /> : <Navigate to="/" replace />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
