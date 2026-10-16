import { createRoot } from "react-dom/client";
import { StorageMaintenance, type StorageMaintenanceBridge } from "./StorageMaintenance";
import "../../styles/app.css";
import "./storage-maintenance.css";

const api = (window as unknown as { storageMaintenance: StorageMaintenanceBridge }).storageMaintenance;
createRoot(document.getElementById("root")!).render(<StorageMaintenance api={api} />);
