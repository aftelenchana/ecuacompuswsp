-- phpMyAdmin SQL Dump
-- version 5.2.0
-- https://www.phpmyadmin.net/
--
-- Servidor: 127.0.0.1
-- Tiempo de generación: 23-10-2024 a las 02:15:34
-- Versión del servidor: 10.4.25-MariaDB
-- Versión de PHP: 7.4.30

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Base de datos: `fff`
--

-- --------------------------------------------------------

--
-- Estructura de tabla para la tabla `variables_globales`
--

CREATE TABLE `variables_globales` (
  `id` int(11) NOT NULL,
  `iduser` int(6) DEFAULT NULL,
  `texto` varchar(400) DEFAULT NULL,
  `fecha` datetime NOT NULL DEFAULT current_timestamp(),
  `estatus` int(2) DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

--
-- Volcado de datos para la tabla `variables_globales`
--

INSERT INTO `variables_globales` (`id`, `iduser`, `texto`, `fecha`, `estatus`) VALUES
(1, 1, 'casa, caballo,cebolla,carro,manzana', '2024-10-16 05:37:34', 0),
(2, 1, 'Hola comor estas ! , Hola un buendia , Buenos Dias, Buenas Nohes, Saludos Cordiales', '2024-10-16 05:41:57', 1),
(3, 279, '', '2024-10-21 10:47:28', 0),
(4, 279, '', '2024-10-21 10:47:50', 0),
(5, 279, 'Hola , hola mundo, Hola caray, Hola bebe', '2024-10-21 10:48:20', 1),
(6, 279, 'muchas gracias , dios le pague', '2024-10-21 11:01:11', 1);

--
-- Índices para tablas volcadas
--

--
-- Indices de la tabla `variables_globales`
--
ALTER TABLE `variables_globales`
  ADD PRIMARY KEY (`id`);

--
-- AUTO_INCREMENT de las tablas volcadas
--

--
-- AUTO_INCREMENT de la tabla `variables_globales`
--
ALTER TABLE `variables_globales`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=7;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
