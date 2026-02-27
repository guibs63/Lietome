// ==================================================
// APP INIT
// ==================================================
const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "3mb" }));

// 🚫 Désactive le cache pour index.html et client.js
// Évite les bugs après deploy Railway (JS obsolète en cache navigateur)
app.get("/client.js", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// IMPORTANT : static APRÈS les routes no-cache
app.use(express.static(__dirname));