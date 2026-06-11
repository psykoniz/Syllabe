import { Routes, Route } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import RunDetail from "./pages/RunDetail";

export default function App() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/runs/:id" element={<RunDetail />} />
      </Routes>
    </div>
  );
}
