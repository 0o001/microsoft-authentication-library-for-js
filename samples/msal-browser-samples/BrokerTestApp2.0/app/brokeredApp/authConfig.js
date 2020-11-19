// Config object to be passed to Msal on creation
const msalConfig = {
    auth: {
        clientId: "abdd063b-76df-4d97-afc3-05dd10c8b017"
    },
    cache: {
        cacheLocation: "sessionStorage", // This configures where your cache will be stored
        storeAuthStateInCookie: false, // Set this to "true" if you are having issues on IE11 or Edge
    },
    system: {
        // TODO: Use interaction type enum
        brokerOptions: {
            allowBrokering: true,
            trustedBrokerDomains: ["http://localhost:30663"],
            brokeredRedirectUri: "http://localhost:30662"
        }
    }
};

// Add here scopes for id token to be used at MS Identity Platform endpoints.
const loginRequest = {
    scopes: ["User.Read"],
    extraQueryParameters: {
        "dc": "ESTS-PUB-WUS2-AZ1-TEST1"
    }
};

// Add here the endpoints for MS Graph API services you would like to use.
const graphConfig = {
    graphMeEndpoint: "https://graph.microsoft-ppe.com/v1.0/me",
    graphMailEndpoint: "https://graph.microsoft-ppe.com/v1.0/me/messages"
};

// Add here scopes for access token to be used at MS Graph API endpoints.
const tokenRequest = {
    scopes: ["Mail.Read"],
    forceRefresh: false // Set this to "true" to skip a cached token and go to the server to get a new token
};

const silentRequest = {
    scopes: ["openid", "profile", "User.Read", "Mail.Read"]
};
