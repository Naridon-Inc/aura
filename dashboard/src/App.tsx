import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import DashboardLayout from './layouts/DashboardLayout';
import Overview from './pages/Overview';
import ReviewList from './pages/ReviewList';
import ReviewDetail from './pages/ReviewDetail';
import Checkpoints from './pages/Checkpoints';
import Analytics from './pages/Analytics';
import Plans from './pages/Plans';
import Rewind from './pages/Rewind';
import Orchestrate from './pages/Orchestrate';
import Settings from './pages/Settings';
import Symphony from './pages/Symphony';
import PullRequests from './pages/PullRequests';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<DashboardLayout />}>
          <Route index element={<Overview />} />
          <Route path="reviews" element={<ReviewList />} />
          <Route path="reviews/:id" element={<ReviewDetail />} />
          <Route path="checkpoints" element={<Checkpoints />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="plans" element={<Plans />} />
          <Route path="rewind" element={<Rewind />} />
          <Route path="orchestrate" element={<Orchestrate />} />
          <Route path="symphony" element={<Symphony />} />
          <Route path="prs" element={<PullRequests />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </Router>
  );
}

export default App;
