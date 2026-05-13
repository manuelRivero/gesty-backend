import { Router } from "express";
import {
  postLogin,
  postLogout,
  postRefresh
} from "../controllers/auth.controller";

const router = Router();

router.post("/login", postLogin);
router.post("/refresh", postRefresh);
router.post("/logout", postLogout);

export default router;
