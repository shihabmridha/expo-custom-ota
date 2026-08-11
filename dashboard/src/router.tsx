import { createBrowserRouter } from 'react-router';
import { AppShell } from './components/AppShell.tsx';
import { ApplicationLayout } from './pages/ApplicationLayout.tsx';
import { ApplicationsPage } from './pages/Applications.tsx';
import { ChannelsPage } from './pages/Channels.tsx';
import { ClientSetupPage } from './pages/ClientSetup.tsx';
import { DeploymentsPage } from './pages/Deployments.tsx';
import { DevicesPage } from './pages/Devices.tsx';
import { LoginPage } from './pages/Login.tsx';
import { NewApplicationPage } from './pages/NewApplication.tsx';
import { OverviewPage } from './pages/Overview.tsx';
import { ReleaseDetailPage } from './pages/ReleaseDetail.tsx';
import { ReleasesPage } from './pages/Releases.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { SigningPage } from './pages/Signing.tsx';
import { SimulatorPage } from './pages/Simulator.tsx';
import { UploadReleasePage } from './pages/UploadRelease.tsx';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <ApplicationsPage /> },
      { path: 'applications', element: <ApplicationsPage /> },
      { path: 'applications/new', element: <NewApplicationPage /> },
      {
        path: 'applications/:id',
        element: <ApplicationLayout />,
        children: [
          { index: true, element: <OverviewPage /> },
          { path: 'releases', element: <ReleasesPage /> },
          { path: 'releases/upload', element: <UploadReleasePage /> },
          { path: 'releases/:releaseId', element: <ReleaseDetailPage /> },
          { path: 'channels', element: <ChannelsPage /> },
          { path: 'deployments', element: <DeploymentsPage /> },
          { path: 'devices', element: <DevicesPage /> },
          { path: 'client-setup', element: <ClientSetupPage /> },
          { path: 'signing', element: <SigningPage /> },
          { path: 'simulator', element: <SimulatorPage /> },
          { path: 'settings', element: <SettingsPage /> },
        ],
      },
    ],
  },
]);
