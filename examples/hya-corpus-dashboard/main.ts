import { runBrowserBenchmark } from './browserBenchmark';
import { renderDashboard } from './dashboard';

const benchmark = new URLSearchParams(window.location.search).get('benchmark') === '1';
document.body.dataset.mode = benchmark ? 'benchmark' : 'dashboard';

void (benchmark ? runBrowserBenchmark() : renderDashboard()).catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  const errorView = document.getElementById('page-error');
  if (errorView) {
    errorView.textContent = message;
    errorView.hidden = false;
  }
  console.error(error);
});
