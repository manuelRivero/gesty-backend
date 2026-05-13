import { Router } from "express";
import {
  getCheckin,
  postCheckinAdd,
  postCheckinClose,
  postCheckinRemove
} from "../controllers/checkin.controller";

const router = Router();

router.get("/:token", getCheckin);
router.post("/:token/add", postCheckinAdd);
router.post("/:token/remove", postCheckinRemove);
router.post("/:token/close", postCheckinClose);

export default router;
