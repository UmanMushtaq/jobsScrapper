import {  IsEmail, IsNotEmpty,  IsOptional, IsString , MaxLength, MinLength } from "class-validator";

export class CreateUserDTO {

    @IsString({message:'first Name must be a string'})
    @IsNotEmpty()
    @MinLength(3, {message: "first Name not less than 3 characters"})
    @MaxLength(20, {message: "first Name not more than 20 characters"})
    firstName:string;

    @IsString({message:'last Name must be a string'})
    @IsNotEmpty()
    @MinLength(3, {message: "last Name not less than 3 characters"})
    @MaxLength(20, {message: "last Name not more than 20 characters"})
    lastName:string;

    @IsEmail()
    @IsNotEmpty()
    @MaxLength(20)
    email:string;

    @IsString()
    @IsNotEmpty()
    @MinLength(8)
    @MaxLength(20)
    password:string;
    @IsString()
    @IsOptional()
    @MaxLength(10)
    gender?:string;

}