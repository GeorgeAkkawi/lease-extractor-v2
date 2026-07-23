import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import TwoFactorChallenge from './pages/TwoFactorChallenge';
import SecuritySettings from './pages/SecuritySettings';
import DisplaySettings from './pages/DisplaySettings';
import NotificationSettings from './pages/NotificationSettings';
import SettingsPage from './pages/SettingsPage';
import DashboardPage from './pages/DashboardPage';
import AskPage from './pages/AskPage';
import CorporationsPage from './pages/CorporationsPage';
import PropertiesPage from './pages/PropertiesPage';
import LeasesPage from './pages/LeasesPage';
import LeaseDetailPage from './pages/LeaseDetailPage';
import LeaseNewPage from './pages/LeaseNewPage';
import ContractsPage from './pages/ContractsPage';
import FinancialsPropertiesPage from './pages/FinancialsPropertiesPage';
import PropertyFinancialsPage from './pages/PropertyFinancialsPage';
import LedgerPage from './pages/LedgerPage';
import HistoryPage from './pages/HistoryPage';
import './App.css';

export default function App() {
  const { session, loading, securityLoading, needsTwoFactor } = useAuth();

  if (loading) return <div className="centered">Loading…</div>;
  if (!session) return <Login />;
  if (securityLoading) return <div className="centered">Loading…</div>;
  if (needsTwoFactor) return <TwoFactorChallenge />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/ask" element={<AskPage />} />

        {/* Leases workspace */}
        <Route path="/leases" element={<CorporationsPage mode="leases" />} />
        <Route path="/leases/:corpId" element={<PropertiesPage mode="leases" />} />
        <Route path="/leases/:corpId/:propId" element={<LeasesPage />} />
        <Route path="/leases/:corpId/:propId/contracts" element={<ContractsPage />} />
        <Route path="/leases/:corpId/:propId/new" element={<LeaseNewPage />} />
        <Route path="/leases/:corpId/:propId/:leaseId" element={<LeaseDetailPage />} />

        {/* Financials workspace */}
        <Route path="/financials" element={<CorporationsPage mode="financials" />} />
        <Route path="/financials/:corpId" element={<FinancialsPropertiesPage mode="financials" />} />
        <Route path="/financials/:corpId/:propId" element={<PropertyFinancialsPage />} />
        <Route path="/financials/:corpId/:propId/ledger" element={<LedgerPage />} />

        {/* History workspace */}
        <Route path="/history" element={<CorporationsPage mode="history" />} />
        <Route path="/history/:corpId" element={<FinancialsPropertiesPage mode="history" />} />
        <Route path="/history/:corpId/:propId" element={<HistoryPage />} />

        {/* Settings hub — sections on the left, content on the right. */}
        <Route path="/settings" element={<SettingsPage />}>
          <Route index element={<Navigate to="display" replace />} />
          <Route path="display" element={<DisplaySettings />} />
          <Route path="notifications" element={<NotificationSettings />} />
          <Route path="security" element={<SecuritySettings />} />
        </Route>
        {/* Old standalone routes now live inside Settings — keep them working. */}
        <Route path="/display" element={<Navigate to="/settings/display" replace />} />
        <Route path="/security" element={<Navigate to="/settings/security" replace />} />

        <Route path="*" element={<Navigate to="/leases" replace />} />
      </Routes>
    </Layout>
  );
}
