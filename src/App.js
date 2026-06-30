import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import TwoFactorChallenge from './pages/TwoFactorChallenge';
import SecuritySettings from './pages/SecuritySettings';
import DashboardPage from './pages/DashboardPage';
import CorporationsPage from './pages/CorporationsPage';
import PropertiesPage from './pages/PropertiesPage';
import LeasesPage from './pages/LeasesPage';
import LeaseDetailPage from './pages/LeaseDetailPage';
import LeaseNewPage from './pages/LeaseNewPage';
import ContractsPage from './pages/ContractsPage';
import FinancialsPropertiesPage from './pages/FinancialsPropertiesPage';
import PropertyFinancialsPage from './pages/PropertyFinancialsPage';
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

        {/* History workspace */}
        <Route path="/history" element={<CorporationsPage mode="history" />} />
        <Route path="/history/:corpId" element={<FinancialsPropertiesPage mode="history" />} />
        <Route path="/history/:corpId/:propId" element={<HistoryPage />} />

        <Route path="/security" element={<SecuritySettings />} />

        <Route path="*" element={<Navigate to="/leases" replace />} />
      </Routes>
    </Layout>
  );
}
