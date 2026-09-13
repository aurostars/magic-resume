import { createMiaobiFaasAdapter } from "../scripts/miaobi/faas-adapter";
import { handleApiRequest } from "../src/lib/server/api-router";

export interface MiaobiFaasRequest extends Request {}

export const handleMiaobiApi = createMiaobiFaasAdapter(handleApiRequest);
