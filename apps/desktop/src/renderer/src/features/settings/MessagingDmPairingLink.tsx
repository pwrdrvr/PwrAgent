import { useEffect } from "react";
import type { GenerateMessagingPairingTokenResponse } from "@pwragent/shared/contracts/messaging";
import "./messaging-dm-pairing-link.css";

export function MessagingDmPairingLink({ link, expiresAt, onExpire }: {
  link: NonNullable<GenerateMessagingPairingTokenResponse["dmLink"]>;
  expiresAt: number;
  onExpire: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onExpire, Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt, onExpire]);

  return (
    <div className="messaging-dm-pairing-link">
      <img src={link.qrImage} alt="QR code for Telegram pairing" width={148} height={148} />
      <div>
        <a className="button button--secondary" href={link.url} target="_blank" rel="noopener noreferrer">
          Open in Telegram
        </a>
        <p>Open Telegram on this computer or scan the QR code with your phone. Tap Start in Telegram, then approve the request here.</p>
      </div>
    </div>
  );
}
