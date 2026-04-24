import React, { useRef, useState } from 'react';
import Cookies from 'js-cookie';
import { generateDerivApiInstance } from '@/external/bot-skeleton/services/api/appId';
import { Localize } from '@deriv-com/translations';
import './api-token-login-modal.scss';

type Props = {
    isOpen: boolean;
    onClose: () => void;
};

type Status = 'idle' | 'loading' | 'error';

const ApiTokenLoginModal: React.FC<Props> = ({ isOpen, onClose }) => {
    const [token, setToken] = useState('');
    const [status, setStatus] = useState<Status>('idle');
    const [errorMsg, setErrorMsg] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    if (!isOpen) return null;

    const handleLogin = async () => {
        const trimmed = token.trim();
        if (!trimmed) {
            setErrorMsg('Please enter your API token.');
            setStatus('error');
            return;
        }

        setStatus('loading');
        setErrorMsg('');

        try {
            const api = generateDerivApiInstance();

            // Wait for socket to open
            await new Promise<void>((resolve, reject) => {
                const conn = (api as any).connection as WebSocket;
                if (conn.readyState === WebSocket.OPEN) {
                    resolve();
                } else {
                    conn.addEventListener('open', () => resolve(), { once: true });
                    conn.addEventListener('error', () => reject(new Error('Connection failed')), { once: true });
                }
            });

            const { authorize, error } = await api.authorize(trimmed);

            api.disconnect();

            if (error) {
                setStatus('error');
                setErrorMsg(
                    error.code === 'InvalidToken'
                        ? 'Invalid API token. Please check and try again.'
                        : error.message || 'Authorization failed.'
                );
                return;
            }

            // Persist auth info matching exactly what AuthWrapper + CoreStoreProvider expect
            const loginid = authorize.loginid;

            // accountsList: { loginid -> token }  (used by useOauth2 & api_base)
            const accountsList: Record<string, string> = {};
            // clientAccounts: { loginid -> { loginid, token, currency } }  (used by auth-utils clearAuthData)
            const clientAccounts: Record<string, { loginid: string; token: string; currency: string }> = {};

            (authorize.account_list || []).forEach((acc: any) => {
                accountsList[acc.loginid] = trimmed;
                clientAccounts[acc.loginid] = {
                    loginid: acc.loginid,
                    token: trimmed,
                    currency: acc.currency || authorize.currency,
                };
            });

            // Always ensure the authorised account itself is present
            accountsList[loginid] = trimmed;
            clientAccounts[loginid] = {
                loginid,
                token: trimmed,
                currency: authorize.currency,
            };

            localStorage.setItem('accountsList', JSON.stringify(accountsList));
            localStorage.setItem('clientAccounts', JSON.stringify(clientAccounts));
            localStorage.setItem('authToken', trimmed);
            localStorage.setItem('active_loginid', loginid);
            if (authorize.country) {
                localStorage.setItem('client.country', authorize.country);
            }

            // Set logged_state cookie — CoreStoreProvider calls oAuthLogout() when this is 'false'
            // We must set it to 'true' so the app knows the user is intentionally logged in
            const cookieDomain = window.location.hostname.split('.').slice(-2).join('.');
            Cookies.set('logged_state', 'true', {
                domain: cookieDomain,
                expires: 30,
                secure: window.location.protocol === 'https:',
                sameSite: 'Lax',
            });

            // Remove any stale OIDC logout cookies that might interfere
            Cookies.remove('is_logging_out');

            onClose();
            // Reload so the app picks up the new auth state
            window.location.reload();
        } catch (err: any) {
            setStatus('error');
            setErrorMsg(err?.message || 'Something went wrong. Please try again.');
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') handleLogin();
    };

    return (
        <div className='api-token-modal__overlay' onClick={onClose}>
            <div className='api-token-modal__box' onClick={e => e.stopPropagation()}>
                <button className='api-token-modal__close' onClick={onClose} aria-label='Close'>
                    ✕
                </button>

                <h2 className='api-token-modal__title'>
                    <Localize i18n_default_text='Log in with API Token' />
                </h2>

                <p className='api-token-modal__description'>
                    <Localize i18n_default_text='Enter a Deriv API token with at least Read permission. You can generate one at app.deriv.com/account/api-token.' />
                </p>

                <input
                    ref={inputRef}
                    className={`api-token-modal__input${status === 'error' ? ' api-token-modal__input--error' : ''}`}
                    type='password'
                    placeholder='Paste your API token here'
                    value={token}
                    onChange={e => {
                        setToken(e.target.value);
                        if (status === 'error') setStatus('idle');
                    }}
                    onKeyDown={handleKeyDown}
                    autoFocus
                    autoComplete='off'
                />

                {status === 'error' && <p className='api-token-modal__error'>{errorMsg}</p>}

                <div className='api-token-modal__actions'>
                    <button
                        className='api-token-modal__btn api-token-modal__btn--secondary'
                        onClick={onClose}
                        disabled={status === 'loading'}
                    >
                        <Localize i18n_default_text='Cancel' />
                    </button>
                    <button
                        className='api-token-modal__btn api-token-modal__btn--primary'
                        onClick={handleLogin}
                        disabled={status === 'loading' || !token.trim()}
                    >
                        {status === 'loading' ? (
                            <span className='api-token-modal__spinner' />
                        ) : (
                            <Localize i18n_default_text='Log in' />
                        )}
                    </button>
                </div>

                <p className='api-token-modal__hint'>
                    <Localize i18n_default_text="Don't have an API token? " />
                    <a
                        href='https://app.deriv.com/account/api-token'
                        target='_blank'
                        rel='noopener noreferrer'
                        className='api-token-modal__link'
                    >
                        <Localize i18n_default_text='Generate one here' />
                    </a>
                </p>
            </div>
        </div>
    );
};

export default ApiTokenLoginModal;
