import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import HomePage from './pages/HomePage';
import BrowsePage from './pages/BrowsePage';
import MovieDetailPage from './pages/MovieDetailPage';
import CreateRoomPage from './pages/CreateRoomPage';
import JoinRoomPage from './pages/JoinRoomPage';
import WatchRoomPage from './pages/WatchRoomPage';
import SoloWatchPage from './pages/SoloWatchPage';
import AuthPage from './pages/AuthPage';

export default function App() {
  return (
    <>
      <Navbar />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/browse" element={<BrowsePage />} />
        <Route path="/movie/:id" element={<MovieDetailPage />} />
        <Route path="/solo" element={<SoloWatchPage />} />
        <Route path="/create-room" element={<CreateRoomPage />} />
        <Route path="/join-room" element={<JoinRoomPage />} />
        <Route path="/join/:roomId" element={<JoinRoomPage />} />
        <Route path="/room/:roomId" element={<WatchRoomPage />} />
        <Route path="/auth" element={<AuthPage />} />
      </Routes>
    </>
  );
}
