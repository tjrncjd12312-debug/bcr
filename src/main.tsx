import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/visual-refresh.css'
import { setupContainer } from './application/di'
import { ErrorProvider, DIProvider } from './presentation/context'
import { ErrorBoundary } from './presentation/components/ErrorBoundary/ErrorBoundary'
import { ToastContainer } from './presentation/components/Toast/Toast'

// Initialize DI Container before rendering
setupContainer()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ErrorProvider>
        <DIProvider>
          <App />
          <ToastContainer />
        </DIProvider>
      </ErrorProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)
