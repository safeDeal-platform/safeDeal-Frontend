import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { App } from './App'
import { AuthProvider } from './auth'
import './styles.css'

// A data router is what makes useBlocker work (the edit screen asks before in-app navigation drops edits).
// One catch-all route keeps every path, the 404 page and location.state inside App's own <Routes>.
const router = createBrowserRouter([
  { path: '*', element: <AuthProvider><App /></AuthProvider> },
])

createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />)
