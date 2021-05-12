/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { AccountInfo, AuthenticationResult, CommonSilentFlowRequest } from "@azure/msal-common";
import { BrokerClientApplication } from "../broker/client/BrokerClientApplication";
import { EmbeddedClientApplication } from "../broker/client/EmbeddedClientApplication";
import { Configuration } from "../config/Configuration";
import { BrowserAuthError } from "../error/BrowserAuthError";
import { EventType } from "../event/EventType";
import { AuthorizationUrlRequest } from "../request/AuthorizationUrlRequest";
import { PopupRequest } from "../request/PopupRequest";
import { SilentRequest } from "../request/SilentRequest";
import { SsoSilentRequest } from "../request/SsoSilentRequest";
import { ApiId, InteractionType } from "../utils/BrowserConstants";
import { BrowserUtils } from "../utils/BrowserUtils";
import { ClientApplication } from "./ClientApplication";
import { IPublicClientApplication } from "./IPublicClientApplication";
import { PopupUtils } from "../utils/PopupUtils";

export class ExperimentalClientApplication extends ClientApplication implements IPublicClientApplication {

    // Broker Objects
    protected embeddedApp?: EmbeddedClientApplication;
    protected broker?: BrokerClientApplication;

    constructor(configuration: Configuration, parent: ClientApplication) {
        super(configuration);
        // bind to parent
        this.initializeBrokering.bind(parent);
        this.handleRedirectPromise.bind(parent);
        this.loginRedirect.bind(parent);
        this.acquireTokenRedirect.bind(parent);
        this.loginPopup.bind(parent);
        this.acquireTokenPopup.bind(parent);
        this.ssoSilent.bind(parent);
        this.acquireTokenSilent.bind(parent);
        this.logout.bind(parent);
        this.logoutPopup.bind(parent);
        this.logoutRedirect.bind(parent);
        this.getAllAccounts.bind(parent);
        this.getAccountByUsername.bind(parent);
        this.getAccountByHomeId.bind(parent);
        this.getAccountByLocalId.bind(parent);
        this.addEventCallback.bind(parent);
        this.removeEventCallback.bind(parent);
        this.getLogger.bind(parent);
        this.setLogger.bind(parent);
    }

    /**
     * 
     */
    async initializeBrokering(): Promise<void> {
        if (!this.isBrowserEnvironment || !this.config.experimental) {
            return;
        }

        if (this.config.experimental.brokerOptions.actAsBroker && !BrowserUtils.isInIframe()) {
            if(this.config.experimental.brokerOptions.allowBrokering) {
                this.logger.verbose("Running in top frame and both actAsBroker, allowBrokering flags set to true. actAsBroker takes precedence.");
            }

            this.broker = new BrokerClientApplication(this.config);
            this.logger.verbose("Acting as Broker");
            this.broker.listenForBrokerMessage();
        } else if (this.config.experimental.brokerOptions.allowBrokering) {
            this.embeddedApp = new EmbeddedClientApplication(this.config.auth.clientId, this.config.experimental.brokerOptions, this.logger, this.browserStorage);
            this.logger.verbose("Acting as child");
            await this.embeddedApp.initiateHandshake();
        }
    }

    /**
     * Event handler function which allows users to fire events after the PublicClientApplication object
     * has loaded during redirect flows. This should be invoked on all page loads involved in redirect
     * auth flows.
     * @param hash Hash to process. Defaults to the current value of window.location.hash. Only needs to be provided explicitly if the response to be handled is not contained in the current value.
     * @returns {Promise.<AuthenticationResult | null>} token response or null. If the return value is null, then no auth redirect was detected.
     */
    async handleRedirectPromise(hash?: string): Promise<AuthenticationResult | null> {
        if (this.broker) {
            return this.broker.handleRedirectPromise(hash);
        } else if (this.embeddedApp && this.embeddedApp.brokerConnectionEstablished) {
            return await this.embeddedApp.sendHandleRedirectRequest();
        }
        return super.handleRedirectPromise(hash);
    }

    // #endregion

    // #region Popup Flow

    /**
     * Use when you want to obtain an access_token for your API via opening a popup window in the user's browser
     * @param {@link (PopupRequest:type)}
     *
     * @returns {Promise.<AuthenticationResult>} - a promise that is fulfilled when this function has completed, or rejected if an error was raised. Returns the {@link AuthResponse} object
     */
    acquireTokenPopup(request: PopupRequest): Promise<AuthenticationResult> {
        try {
            // Preflight request
            this.preflightBrowserEnvironmentCheck(InteractionType.Popup);
            const validRequest: AuthorizationUrlRequest = this.preflightInteractiveRequest(request, InteractionType.Popup);
            if (this.embeddedApp && this.embeddedApp.brokerConnectionEstablished) {
                return this.embeddedApp.sendPopupRequest(validRequest);
            }
            this.browserStorage.updateCacheEntries(validRequest.state, validRequest.nonce, validRequest.authority);
            const popupName = PopupUtils.generatePopupName(this.config.auth.clientId, validRequest);

            // asyncPopups flag is true. Acquires token without first opening popup. Popup will be opened later asynchronously.
            if (this.config.system.asyncPopups) {
                return this.acquireTokenPopupAsync(validRequest, popupName);
            } else {
                // asyncPopups flag is set to false. Opens popup before acquiring token.
                const popup = PopupUtils.openSizedPopup("about:blank", popupName);
                return this.acquireTokenPopupAsync(validRequest, popupName, popup);
            }
        } catch (e) {
            // Since this function is synchronous we need to reject
            return Promise.reject(e);
        }
    }

    // #endregion

    // #region Silent Flow

    /**
     * This function uses a hidden iframe to fetch an authorization code from the eSTS. There are cases where this may not work:
     * - Any browser using a form of Intelligent Tracking Prevention
     * - If there is not an established session with the service
     *
     * In these cases, the request must be done inside a popup or full frame redirect.
     *
     * For the cases where interaction is required, you cannot send a request with prompt=none.
     *
     * If your refresh token has expired, you can use this function to fetch a new set of tokens silently as long as
     * you session on the server still exists.
     * @param {@link AuthorizationUrlRequest}
     *
     * @returns {Promise.<AuthenticationResult>} - a promise that is fulfilled when this function has completed, or rejected if an error was raised. Returns the {@link AuthResponse} object
     */
    async ssoSilent(request: SsoSilentRequest): Promise<AuthenticationResult> {
        this.preflightBrowserEnvironmentCheck(InteractionType.Silent);
        this.logger.verbose("ssoSilent called");
        this.emitEvent(EventType.SSO_SILENT_START, InteractionType.Silent, request);

        try {
            if (this.embeddedApp && this.embeddedApp.brokerConnectionEstablished) {
                return this.embeddedApp.sendSsoSilentRequest(request);
            }
            
            const silentTokenResult = await this.acquireTokenByIframe(request, ApiId.ssoSilent);
            this.emitEvent(EventType.SSO_SILENT_SUCCESS, InteractionType.Silent, silentTokenResult);
            return silentTokenResult;
        } catch (e) {
            this.emitEvent(EventType.SSO_SILENT_FAILURE, InteractionType.Silent, null, e);
            throw e;
        }
    }

    /**
     * Silently acquire an access token for a given set of scopes. Will use cached token if available, otherwise will attempt to acquire a new token from the network via refresh token.
     * 
     * @param {@link (SilentRequest:type)} 
     * @returns {Promise.<AuthenticationResult>} - a promise that is fulfilled when this function has completed, or rejected if an error was raised. Returns the {@link AuthResponse} object
     */
    async acquireTokenSilent(request: SilentRequest): Promise<AuthenticationResult> {
        this.preflightBrowserEnvironmentCheck(InteractionType.Silent);
        const accountObj = request.account || this.getActiveAccount();
        if (!accountObj) {
            throw BrowserAuthError.createNoAccountError();
        }
        const silentRequest: CommonSilentFlowRequest = {
            ...request,
            ...this.initializeBaseRequest(request),
            account: accountObj,
            forceRefresh: request.forceRefresh || false
        };
        this.emitEvent(EventType.ACQUIRE_TOKEN_START, InteractionType.Silent, request);

        try {
            // Telemetry manager only used to increment cacheHits here
            const serverTelemetryManager = this.initializeServerTelemetryManager(ApiId.acquireTokenSilent_silentFlow, silentRequest.correlationId);
            const silentAuthClient = await this.createSilentFlowClient(serverTelemetryManager, silentRequest.authority);
            const cachedToken = await silentAuthClient.acquireCachedToken(silentRequest);
            this.emitEvent(EventType.ACQUIRE_TOKEN_SUCCESS, InteractionType.Silent, cachedToken);
            return cachedToken;
        } catch (e) {
            try {
                if (this.embeddedApp && this.embeddedApp.brokerConnectionEstablished) {
                    return this.embeddedApp.sendSilentRefreshRequest(request);
                }
                const tokenRenewalResult = await this.acquireTokenByRefreshToken(silentRequest);
                this.emitEvent(EventType.ACQUIRE_TOKEN_SUCCESS, InteractionType.Silent, tokenRenewalResult);
                return tokenRenewalResult;
            } catch (tokenRenewalError) {
                this.emitEvent(EventType.ACQUIRE_TOKEN_FAILURE, InteractionType.Silent, null, tokenRenewalError);
                throw tokenRenewalError;
            }
        }
    }

    // #endregion

    /**
     * Sets the account to use as the active account. If no account is passed to the acquireToken APIs, then MSAL will use this active account.
     * @param account 
     */
    setActiveAccount(account: AccountInfo | null): void {
        if (this.broker) {
            this.broker.setActiveAccount(account);
        }
        super.setActiveAccount(account);
    }
}
