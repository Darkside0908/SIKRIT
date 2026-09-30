import { Shell } from "./components/Shell";
import { useRoute } from "./lib/router";
import { CapsulePage } from "./pages/Capsule";
import { GuardianPage } from "./pages/Guardian";
import { HeirPage } from "./pages/Heir";
import { Home } from "./pages/Home";
import { OwnerPage } from "./pages/Owner";

export function App() {
  const route = useRoute();
  return (
    <Shell route={route}>
      {route.page === "home" && <Home />}
      {route.page === "owner" && <OwnerPage />}
      {route.page === "heir" && <HeirPage />}
      {route.page === "guardian" && <GuardianPage />}
      {route.page === "capsule" && <CapsulePage address={route.address} />}
    </Shell>
  );
}
