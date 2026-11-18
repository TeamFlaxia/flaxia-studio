import './styles/app.css';
import { startApp } from './app';
import { completeSignInFromUrl } from './lib/auth';
import { toast } from './ui/toast';

const signedIn = completeSignInFromUrl();
startApp();
if (signedIn) toast('Signed in', 'Your Flaxia account is available in Connections.', 'success', 2400);
