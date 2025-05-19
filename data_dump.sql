--
-- PostgreSQL database dump
--

-- Dumped from database version 17.4
-- Dumped by pg_dump version 17.4 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: Admin; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."Admin" (id, name, email, password, permissions, "createdAt", "updatedAt") FROM stdin;
1	admin	admin@gmail.com	12345678	{""}	2025-05-18 18:51:24.631	2025-05-18 18:51:24.631
\.


--
-- Data for Name: Category; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."Category" (id, name, "createdAt", "updatedAt") FROM stdin;
1	Business	2025-05-18 18:51:37.144	2025-05-18 18:51:37.144
\.


--
-- Data for Name: SubscriptionPlan; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."SubscriptionPlan" (id, name, description, "durationDays", "promotionDays", "tierType", "isActive", "adminId", "createdAt", "updatedAt", price) FROM stdin;
1	Free	Basic listing with essential features	30	0	FREE	t	1	2025-05-18 18:54:08.874	2025-05-18 18:54:08.874	0
3	Premium+	Maximum visibility with extended promotion and longest duration	120	30	PREMIUM_PLUS	t	1	2025-05-18 18:54:08.874	2025-05-18 18:54:08.874	150
2	Premium	Enhanced visibility with promotion and extended duration	60	7	PREMIUM	t	1	2025-05-18 18:54:08.874	2025-05-18 18:54:08.874	8.5
\.


--
-- Data for Name: User; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."User" (id, email, password, "firstName", "lastName", phone, city, "createdAt", "updatedAt") FROM stdin;
1	user@gmail.com	$2b$10$fN73D/MWkZ9AEbFN90mHzulzEgzYU/7E.2K2aBMUnn4sSTVetO/ta	User	Test	1234567890	user@gmail.com	2025-05-18 18:52:13.355	2025-05-18 18:52:13.355
\.


--
-- Data for Name: Listing; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."Listing" (id, title, description, slug, type, price, negotiable, city, tags, highlights, "businessHours", phone, website, status, "listingTier", "categoryId", "userId", "businessCategory", "establishedYear", "serviceArea", "teamSize", rating, "reviewCount", "createdAt", "updatedAt", "expiresAt", "isBannerEnabled", "subscriptionId") FROM stdin;
1	Listing 1	Minimum 50 characters, maximum 2000 characters.	listing-1	PROFESSIONAL	1250	f	Los Angeles	{tags}	{}	{"sunday": {"open": "", "close": ""}, "saturday": {"open": "10:00 AM", "close": "4:00 PM"}, "weekdays": {"open": "9:00 AM", "close": "6:00 PM"}}	9876543210	\N	APPROVED	PREMIUM_PLUS	1	1	\N	\N	\N	\N	\N	\N	2025-05-18 18:54:14.817	2025-05-18 19:03:08.911	2025-09-15 19:03:08.909	t	3
2	Listing 2	Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.	listing-2	PROFESSIONAL	10000	t	New York	{seller}	{"Free consultation","10+ years experience"}	{"sunday": {"open": "", "close": ""}, "saturday": {"open": "10:00 AM", "close": "4:00 PM"}, "weekdays": {"open": "09:00", "close": "18:00"}}	9876503214	https://vyapaar-frontend.vercel.app/	APPROVED	PREMIUM	1	1	Retail	2016	25 KM	2-5	\N	\N	2025-05-18 19:06:28.224	2025-05-18 19:07:00.76	2025-07-17 19:07:00.758	t	2
\.


--
-- Data for Name: AdminApproval; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."AdminApproval" (id, "listingId", "adminId", status, comments, "createdAt", "updatedAt") FROM stdin;
\.


--
-- Data for Name: Favorite; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."Favorite" (id, "userId", "listingId", "createdAt") FROM stdin;
\.


--
-- Data for Name: Image; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."Image" (id, url, "isPrimary", "isBanner", "listingId") FROM stdin;
\.


--
-- Data for Name: ListingImage; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."ListingImage" (id, url, "listingId", "isPrimary", "createdAt") FROM stdin;
\.


--
-- Data for Name: Message; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."Message" (id, "senderId", "receiverId", "listingId", content, "isRead", "createdAt") FROM stdin;
\.


--
-- Data for Name: Payment; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."Payment" (id, "listingId", amount, currency, "paymentMethod", "transactionId", status, "createdAt", "updatedAt") FROM stdin;
7a09fc55-5fbc-4590-a204-0944f74613d5	1	150	INR	RAZORPAY	pay_QWV4jJFiwbqAU4	COMPLETED	2025-05-18 19:03:09.481	2025-05-18 19:03:09.481
19934969-5ad9-4285-9e39-40399240314b	2	8.5	INR	RAZORPAY	pay_QWV8ojsMd5dJ0G	COMPLETED	2025-05-18 19:07:01.441	2025-05-18 19:07:01.441
\.


--
-- Data for Name: Promotion; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public."Promotion" (id, "listingId", price, "startDate", "endDate", "durationDays", "isActive", "createdAt", "updatedAt") FROM stdin;
98120f5f-f866-4f38-91da-51fc622d6b31	1	0	2025-05-18 18:54:16.082	2025-06-17 18:54:16.082	30	t	2025-05-18 18:54:16.084	2025-05-18 18:54:16.084
34940388-50ef-46e6-a731-916a9aa89f07	1	0	2025-05-18 19:03:09.196	2025-06-17 19:03:09.196	30	t	2025-05-18 19:03:09.197	2025-05-18 19:03:09.197
de7f2bfa-0ad3-46b7-b3ae-8a83706038b8	2	0	2025-05-18 19:06:29.527	2025-05-25 19:06:29.527	7	t	2025-05-18 19:06:29.529	2025-05-18 19:06:29.529
3e34b445-2e96-4c90-95a4-edb69d17dc6a	2	0	2025-05-18 19:07:01.058	2025-05-25 19:07:01.058	7	t	2025-05-18 19:07:01.059	2025-05-18 19:07:01.059
\.


--
-- Data for Name: _prisma_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public._prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) FROM stdin;
ad5de24e-a894-478f-9bfd-65d5196056c4	1269160ad5347a8e9880dc9c15b56a6e1e13353880bd619b46e1ead3acc05c13	2025-05-18 18:47:55.870933+00	20250518184748_init	\N	\N	2025-05-18 18:47:55.087268+00	1
\.


--
-- Name: Listing_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public."Listing_id_seq"', 2, true);


--
-- Name: User_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public."User_id_seq"', 1, true);


--
-- PostgreSQL database dump complete
--

