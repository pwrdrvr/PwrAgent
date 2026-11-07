Public test-only localhost TLS certificate and private key. These invented credentials
are deliberately checked in for portable HTTPS/WebSocket tests, never production.
Do not install this certificate into a user trust store or use this key for a gateway.
The tests trust it only through the HTTPS/WebSocket client `ca` option.
